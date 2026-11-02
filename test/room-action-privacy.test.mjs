// MIND-04 AC2 · Privacy (I2): scripted games in all 4 variants, played through the room-action service. Every
// value written to public_state and room_events.payload, every hand row, and every response sent to a player is
// scanned. None may show a card still held in another player's hand, the seed or the RNG state; in Blind, no
// played value may appear before the level's reveal.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createRoomActionService } from '../supabase/functions/_shared/room-action.mjs';
import { createMemoryRoomActionRepo } from '../supabase/functions/_shared/room-action-memory-repo.mjs';

const Mind = createRequire(import.meta.url)('../engine/mind-engine.js');
const { MindEngine } = Mind;

const ROOM = '44444444-4444-4444-8444-000000000001';
const USERS = [1, 2, 3].map((n) => `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`);
const STEP = 50;
const MAX_STEPS = 24000;

// Card values found in fields named v, top, hand and cards (the same scan as the MIND-02 engine tests).
function cardValues(node, out = [], key = null) {
  if (Array.isArray(node)) {
    for (const x of node) {
      if (typeof x === 'number') { if (key === 'hand' || key === 'cards') out.push(x); } else cardValues(x, out, key);
    }
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'v' || k === 'top') && typeof v === 'number') out.push(v);
      else cardValues(v, out, k);
    }
  }
  return out;
}

function allNumbersAndKeys(node, numbers = [], keys = []) {
  if (Array.isArray(node)) node.forEach((x) => allNumbersAndKeys(x, numbers, keys));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) { keys.push(k); allNumbersAndKeys(v, numbers, keys); }
  } else if (typeof node === 'number') numbers.push(node);
  return { numbers, keys };
}

// Deterministic players that read the table like a person would (careful ones only play their card when it is the
// lowest anywhere). Messy ones make mistakes, refocus, reject stars and let votes time out.
function decide(e, t, careful) {
  const step = Math.round(t / STEP);
  const ps = e.players;
  const acts = [];
  switch (e.phase) {
    case 'sync':
      ps.forEach((p, i) => { if (!p.handDown && step % (3 + i) === 0) acts.push([p.seat, 'handDown']); });
      break;
    case 'playing': {
      if (step % 157 === 0 && e.stars > 0) { acts.push([step % ps.length, 'proposeStar']); break; }
      if (!careful && !e.blind && step % 229 === 0) { acts.push([(step + 1) % ps.length, 'refocus']); break; }
      if (step % 311 === 0) { acts.push([(step + 2) % ps.length, 'pause']); break; }
      ps.forEach((p, i) => {
        for (const pile of e.piles) {
          const c = e.urgent(p, pile.id);
          if (!c) continue;
          if (careful && ps.some((o) => o !== p && o.hand.some((x) => x.pile === pile.id && e.dist(x, pile) < e.dist(c, pile)))) continue;
          const gap = Math.max(0, e.dist(c, pile));
          if (t - pile.clockStart >= 250 + gap * (careful ? 40 : 60 + 25 * i)) acts.push([p.seat, 'play', { pileId: pile.id }]);
        }
      });
      break;
    }
    case 'starVote':
      ps.forEach((p, i) => {
        const v = e.vote;
        if (!v || v.votes[p.id] !== undefined) return;
        if (!careful && i === ps.length - 1 && e.level % 3 === 0) return;
        if (t - v.startedAt >= 300 * (i + 1)) acts.push([p.seat, 'voteStar', { agree: careful || (e.level + i) % 4 !== 0 }]);
      });
      break;
    case 'paused':
      if (t - e.pausedAt >= 1500) acts.push([(step + 1) % ps.length, 'resume']);
      break;
    case 'levelComplete':
      if (step % 7 === 0) acts.push([step % ps.length, 'nextLevel']);
      break;
    default:
      break;
  }
  return acts;
}

function playScripted({ variant, seed, careful }) {
  let t = 1_000_000;
  const repo = createMemoryRoomActionRepo({ now: () => t });
  repo.addRoom({ id: ROOM, hostId: USERS[0], variant, players: USERS.map((userId, seat) => ({ userId, seat, nickname: `P${seat}` })) });
  const svc = createRoomActionService({ repo, Mind, randomSeed: () => seed, rateLimiter: { allow: () => true } });
  const room = repo.room(ROOM);
  const seen = new Set();
  let checks = 0;
  let lastVersion = -1;
  let lastEvents = 0;
  let cached = null;
  const engine = () => {
    if (!cached || cached.version !== room.version) cached = { version: room.version, e: MindEngine.fromJSON(room.engineState) };
    return cached.e;
  };

  // Scans one payload for the viewer (seat id, or null for everyone) against the stored, hidden state.
  function scan(what, payload, viewer) {
    const e = MindEngine.fromJSON(room.engineState);
    const foreign = new Set(e.players.filter((p) => p.id !== viewer).flatMap((p) => p.hand.map((c) => c.v)));
    const played = e.blind && !e.revealed ? new Set(e.piles.flatMap((p) => p.cards.map((c) => c.v))) : new Set();
    for (const v of cardValues(payload)) {
      assert.ok(!foreign.has(v), `${variant}: ${what} for ${viewer} shows ${v} from another player's hand`);
      assert.ok(!played.has(v), `${variant}: ${what} for ${viewer} shows played Blind card ${v} before the reveal`);
    }
    const { numbers, keys } = allNumbersAndKeys(payload);
    const rngState = room.engineState.rngState;
    assert.ok(Number.isInteger(rngState));
    assert.ok(!numbers.includes(seed) && !numbers.includes(rngState), `${variant}: ${what} for ${viewer} shows the seed or RNG state`);
    assert.ok(!keys.includes('rngState') && !keys.includes('seed'), `${variant}: ${what} has an RNG field`);
    checks++;
  }

  function afterEveryCall(seat, reply) {
    scan(`response to s${seat}`, reply.body, `s${seat}`);
    if (room.version !== lastVersion) {
      lastVersion = room.version;
      scan('public_state', room.publicState, null);
      for (const ev of room.events.slice(lastEvents)) {
        seen.add(ev.type);
        scan(`room_events '${ev.type}'`, ev.payload, null);
      }
      lastEvents = room.events.length;
      const e = MindEngine.fromJSON(room.engineState);
      for (const p of e.players) {
        const row = room.hands.get(USERS[p.seat]);
        assert.deepEqual(row.hand, p.hand.map((c) => ({ v: c.v, pile: c.pile })), `${variant}: hand row of ${p.id} is out of date`);
      }
    }
  }

  const send = async (seat, type, extra = {}) => {
    const reply = await svc.run(USERS[seat], { roomId: ROOM, type, ...extra });
    assert.ok(reply.status === 200 || reply.body.error.code === 'INVALID_MOVE', `${type}: ${JSON.stringify(reply.body.error)}`);
    afterEveryCall(seat, reply);
    return reply;
  };

  return (async () => {
    await send(0, 'start');
    for (let i = 0; i < MAX_STEPS && room.status === 'playing'; i++) {
      t += STEP;
      const due = engine().nextDeadline();
      if (due != null && t >= due) await send(i % 3, 'tick');
      for (const [seat, type, extra] of decide(engine(), t, careful)) await send(seat, type, extra);
    }
    assert.equal(room.status, 'finished', `${variant} seed ${seed} did not finish`);
    return { seen, checks, result: room.publicState.result };
  })();
}

const SCRIPTS = [
  { seed: 2654435769, careful: false }, { seed: 2246822519, careful: false },
  { seed: 3141592653, careful: true }, { seed: 4058973443, careful: true },
];
const EXPECTED_EVENTS = {
  common: ['levelStart', 'syncStart', 'handDown', 'allHandsDown', 'playing', 'play', 'starProposed', 'starVote', 'paused', 'resumed'],
  blind: ['reveal'],
  sighted: ['mistake', 'refocusCalled'],
};

describe('privacy through the server (AC2)', () => {
  it('the scan finds card values, so the checks can fail', () => {
    assert.deepEqual(cardValues({ hand: [{ v: 7 }], piles: [{ top: 9, cards: [{ v: 3 }] }], x: { hand: [5] } }).sort((a, b) => a - b), [3, 5, 7, 9]);
  });

  for (const variant of ['classic', 'reverse', 'blind', 'dual']) {
    it(`${variant}: public state, events, hand rows and every response keep other hands${variant === 'blind' ? ' and unrevealed plays' : ''} hidden`, async () => {
      const seen = new Set();
      for (const script of SCRIPTS) {
        const run = await playScripted({ variant, ...script });
        run.seen.forEach((x) => seen.add(x));
        assert.ok(run.checks > 100, `${variant}: only ${run.checks} checks`);
        assert.equal(run.result.variant, variant);
      }
      const expected = EXPECTED_EVENTS.common.concat(variant === 'blind' ? EXPECTED_EVENTS.blind : EXPECTED_EVENTS.sighted);
      for (const type of expected) assert.ok(seen.has(type), `${variant}: the scripts never produced '${type}'`);
      assert.ok(seen.has('levelComplete') || seen.has('gameOver'));
    });
  }
});
