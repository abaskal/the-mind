'use strict';

// MIND-02 tests: many humans, save/restore, per-player views, event redaction and deadlines.
// The MIND-01 characterization tests (test/engine.test.js) must keep passing unchanged next to these.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { MindEngine, mulberry32, redactEvent, TIMING } = require('../engine/mind-engine.js');

const VARIANT_IDS = ['classic', 'reverse', 'blind', 'dual'];
const ALL_EVENTS = [
  'levelStart', 'syncStart', 'handDown', 'allHandsDown', 'playing', 'play', 'perfectSync', 'mistake',
  'starProposed', 'starVote', 'starRejected', 'star', 'refocusCalled', 'reveal', 'levelComplete',
  'victory', 'gameOver', 'paused', 'resumed',
];
const ENDED = ['victory', 'gameOver'];
const STEP = 50;
const MAX_T = 1200000;

const snapshot = (e) => JSON.stringify(e.toJSON());
const values = (p) => p.hand.map((c) => c.v);
const eventsOf = (events, type) => events.filter((x) => x.type === type).map((x) => x.data);
const typesOf = (events) => events.map((x) => x.type);

function makeTable({ humans = ['A', 'B', 'C'], bots = [], variant, seed = 1 } = {}) {
  const players = humans.map((id) => ({ id, human: true })).concat(bots.map((id) => ({ id })));
  const e = new MindEngine({ players, variant, seed });
  const events = [];
  e.on('*', (type, data) => events.push({ type, data: JSON.parse(JSON.stringify(data)) }));
  return { e, events };
}

// Replaces the dealt hands while the table is in sync (bots then plan with these cards).
function setHands(e, hands) {
  assert.equal(e.phase, 'sync');
  for (const p of e.players) {
    p.hand = (hands[p.id] || []).map((c) => (typeof c === 'number' ? { v: c, pile: e.piles[0].id } : { v: c.v, pile: c.pile }));
  }
}

// Every human puts their hand down at t, bots follow, and the sync hold runs out; returns when play started.
function syncAll(e, t) {
  for (const p of e.players) if (p.human && !p.handDown) assert.equal(e.placeHand(p.id, t), true);
  if (e.players.some((p) => !p.human)) e.tick(t + 2000);
  const at = e.allDownAt + TIMING.syncHold;
  e.tick(at);
  assert.equal(e.phase, 'playing');
  return at;
}

// Classic only: the player holding the lowest card plays it, until the level ends. Plays are 1.5 s apart,
// outside the perfect-sync window, so the event sequence stays simple.
function playInOrder(e, t) {
  while (e.phase === 'playing') {
    const holder = e.players.filter((p) => p.hand.length).sort((a, b) => a.hand[0].v - b.hand[0].v)[0];
    t += 1500;
    assert.equal(e.playCard(holder.id, null, t), true);
  }
  return t;
}

function setup3(hands, opts) {
  const { e, events } = makeTable(opts);
  e.start(0);
  setHands(e, hands);
  return { e, events, t: syncAll(e, 0) };
}

// A deterministic table: every move depends only on the engine state and t, so an engine restored from JSON
// receives exactly the same moves. "careful" humans only play when they hold the most urgent card (they win);
// otherwise each human has their own tempo, so they make mistakes, refocus, reject stars and let votes time out.
function policy(e, t, careful) {
  const step = Math.round(t / STEP);
  const humans = e.players.filter((p) => p.human);
  switch (e.phase) {
    case 'sync':
      humans.forEach((h, i) => { if (!h.handDown && step % (3 + i) === 0) e.placeHand(h.id, t); });
      break;
    case 'playing': {
      if (step % 157 === 0 && e.stars > 0) { e.proposeStar(humans[step % humans.length].id, t); break; }
      if (!careful && !e.blind && step % 229 === 0) { e.callRefocus(humans[(step + 1) % humans.length].id, t); break; }
      if (step % 311 === 0) { e.pause(humans[(step + 2) % humans.length].id, t); break; }
      humans.forEach((h, i) => {
        for (const pile of e.piles) {
          const c = e.urgent(h, pile.id);
          if (!c) continue;
          if (careful && e.players.some((p) => p !== h && p.hand.some((x) => x.pile === pile.id && e.dist(x, pile) < e.dist(c, pile)))) continue;
          const gap = Math.max(0, e.dist(c, pile));
          if (t - pile.clockStart >= 250 + gap * (careful ? 40 : 60 + 25 * i)) e.playCard(h.id, pile.id, t);
        }
      });
      break;
    }
    case 'starVote':
      humans.forEach((h, i) => {
        const v = e.vote;
        if (!v || v.votes[h.id] !== undefined) return;
        if (!careful && i === humans.length - 1 && e.level % 3 === 0) return;
        if (t - v.startedAt >= 300 * (i + 1)) e.voteStar(h.id, careful || (e.level + i) % 4 !== 0, t);
      });
      break;
    case 'paused':
      if (t - e.pausedAt >= 1500) e.resume(humans[0].id, t);
      break;
    case 'levelComplete':
      if (step % 7 === 0) e.nextLevel(t);
      break;
    default:
      break;
  }
}

// Plays a scripted game. restore(e, t) → true swaps the engine for one restored from its JSON before that step.
function runScripted({ variant, seed, bots = [], careful = false, restore, onEvent, checkTick }) {
  const humans = bots.length ? ['A', 'B'] : ['A', 'B', 'C'];
  const players = humans.map((id) => ({ id, human: true })).concat(bots.map((id) => ({ id })));
  let e = new MindEngine({ players, variant, seed });
  const events = [];
  const listener = (type, data, engine) => {
    events.push({ type, data: JSON.parse(JSON.stringify(data)) });
    if (onEvent) onEvent(type, data, engine);
  };
  e.on('*', listener);
  e.start(0);
  let restored = 0, dueTicks = 0;
  for (let t = STEP; t <= MAX_T && !ENDED.includes(e.phase); t += STEP) {
    if (restore && restore(e, t)) {
      e = MindEngine.fromJSON(JSON.parse(JSON.stringify(e.toJSON())));
      e.on('*', listener);
      restored++;
    }
    if (checkTick) {
      const due = e.nextDeadline();
      const before = snapshot(e);
      e.tick(t);
      const changed = snapshot(e) !== before;
      if (due == null || t < due) assert.equal(changed, false, `tick(${t}) changed ${e.phase} before its deadline ${due}`);
      else { assert.equal(changed, true, `tick(${t}) did nothing at deadline ${due}`); dueTicks++; }
    } else {
      e.tick(t);
    }
    policy(e, t, careful);
  }
  assert.ok(ENDED.includes(e.phase), `${variant} seed ${seed} did not finish`);
  return { e, events, restored, dueTicks };
}

const SCRIPTS = {
  classic: [{ seed: 2 }, { seed: 2, bots: ['x1'] }, { seed: 1, careful: true }, { seed: 1, bots: ['x1'], careful: true }],
  reverse: [{ seed: 3 }, { seed: 1, bots: ['x1'] }, { seed: 1, careful: true }, { seed: 1, bots: ['x1'], careful: true }],
  blind: [{ seed: 1 }, { seed: 4, bots: ['x1'] }, { seed: 1, careful: true }, { seed: 1, bots: ['x1'], careful: true }],
  dual: [{ seed: 1 }, { seed: 2, bots: ['x1'] }, { seed: 1, careful: true }, { seed: 1, bots: ['x1'], careful: true }],
};
const label = (s) => `${s.bots ? '2 humans + 1 bot' : '3 humans'}, ${s.careful ? 'careful' : 'messy'}, seed ${s.seed}`;

// Card values found in fields named v, hand, cards and top (AC4's scan).
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

describe('three humans, no bots (AC2)', () => {
  it('Classic levels 1 and 2: hands down, play, level complete, reward', () => {
    const { e, events } = makeTable({ seed: 11 });
    e.start(0);
    assert.deepEqual([e.maxLevel, e.lives, e.stars], [10, 3, 1]);
    assert.equal(e.nextDeadline(), null);
    let t = syncAll(e, 0);
    t = playInOrder(e, t);
    assert.equal(e.phase, 'levelComplete');
    assert.deepEqual(typesOf(events), [
      'levelStart', 'syncStart', 'handDown', 'handDown', 'handDown', 'allHandsDown', 'playing', 'play', 'play', 'play', 'levelComplete',
    ]);
    assert.deepEqual(eventsOf(events, 'handDown').map((d) => d.playerId), ['A', 'B', 'C']);
    const order = eventsOf(events, 'play').map((d) => d.card.v);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.deepEqual(eventsOf(events, 'levelComplete')[0], { level: 1, reward: null, applied: false, flawless: true, lives: 3, stars: 1 });

    assert.equal(e.nextLevel(t + 100), true);
    assert.equal(e.level, 2);
    assert.ok(e.players.every((p) => p.hand.length === 2));
    t = playInOrder(e, syncAll(e, t + 200));
    assert.deepEqual(eventsOf(events, 'levelComplete')[1], { level: 2, reward: 'star', applied: true, flawless: true, lives: 3, stars: 2 });
    assert.equal(e.stats.plays, 9);
  });

  it('a mistake by B discards the lower cards of A and C and costs exactly 1 life', () => {
    const { e, events, t } = setup3({ A: [10, 70], B: [40], C: [5, 30, 90] });
    assert.equal(e.playCard('B', null, t), true);
    assert.equal(e.lives, 2);
    assert.deepEqual(e.players.map(values), [[70], [], [90]]);
    assert.deepEqual(eventsOf(events, 'mistake'), [{
      playerId: 'B', card: { v: 40, pile: 'up' }, offenders: [{ playerId: 'A', cards: [10] }, { playerId: 'C', cards: [5, 30] }], lives: 2,
    }]);
    assert.equal(e.stats.livesLost, 1);
    e.tick(t + TIMING.mistakePause);
    assert.equal(e.phase, 'sync');
    assert.equal(e.lives, 2);
  });

  it('a star vote passes when every human says yes', () => {
    const { e, events, t } = setup3({ A: [10, 60], B: [20, 70], C: [30, 80] });
    assert.equal(e.proposeStar('A', t), true);
    assert.deepEqual(eventsOf(events, 'starProposed'), [{ proposer: 'A', needsHuman: true }]);
    assert.deepEqual(e.vote.votes, { A: true });
    assert.equal(e.voteStar('B', true, t + 100), true);
    assert.equal(e.phase, 'starVote');
    assert.equal(e.voteStar('C', true, t + 200), true);
    assert.equal(e.phase, 'resolving');
    assert.equal(e.stars, 0);
    assert.deepEqual(e.players.map(values), [[60], [70], [80]]);
    assert.deepEqual(eventsOf(events, 'star')[0].discards.map((d) => [d.playerId, d.v]), [['A', 10], ['B', 20], ['C', 30]]);
  });

  it('a star vote fails when one human says no', () => {
    const { e, events, t } = setup3({ A: [10, 60], B: [20, 70], C: [30, 80] });
    e.proposeStar('A', t);
    e.voteStar('B', true, t + 100);
    assert.equal(e.voteStar('C', false, t + 200), true);
    assert.deepEqual(eventsOf(events, 'starRejected'), [{ by: 'C' }]);
    assert.equal(e.phase, 'playing');
    assert.equal(e.stars, 1);
    assert.deepEqual(e.players.map(values), [[10, 60], [20, 70], [30, 80]]);
  });

  it('a star vote fails on timeout when one human does not vote', () => {
    const { e, events, t } = setup3({ A: [10, 60], B: [20, 70], C: [30, 80] });
    e.proposeStar('A', t);
    e.voteStar('B', true, t + 100);
    assert.equal(e.nextDeadline(), t + TIMING.voteTimeout);
    e.tick(t + TIMING.voteTimeout - 1);
    assert.equal(e.phase, 'starVote');
    e.tick(t + TIMING.voteTimeout);
    assert.deepEqual(eventsOf(events, 'starVote').at(-1), { playerId: 'C', agree: false, timeout: true });
    assert.deepEqual(eventsOf(events, 'starRejected'), [{ by: 'C' }]);
    assert.equal(e.stars, 1);
  });

  it('every silent human times out, and the first in seat order rejects', () => {
    const { e, events, t } = setup3({ A: [10], B: [20], C: [30] });
    e.proposeStar('C', t);
    e.tick(t + TIMING.voteTimeout);
    assert.deepEqual(eventsOf(events, 'starVote'), [
      { playerId: 'A', agree: false, timeout: true },
      { playerId: 'B', agree: false, timeout: true },
    ]);
    assert.deepEqual(eventsOf(events, 'starRejected'), [{ by: 'A' }]);
  });

  it('refocus by C, then pause by A and resume by B', () => {
    const { e, events, t } = setup3({ A: [10, 60], B: [20, 70], C: [30, 80] });
    assert.equal(e.callRefocus('C', t + 500), true);
    assert.deepEqual(eventsOf(events, 'refocusCalled'), [{ playerId: 'C' }]);
    assert.deepEqual(eventsOf(events, 'syncStart').at(-1), { reason: 'refocus' });
    const t2 = syncAll(e, t + 1000);
    assert.equal(e.pause('A', t2 + 1000), true);
    assert.equal(e.viewFor('C').pausedBy, 'A');
    assert.equal(e.pause('B', t2 + 1100), false);
    assert.equal(e.resume('B', t2 + 4000), true);
    assert.deepEqual(eventsOf(events, 'paused'), [{ playerId: 'A' }]);
    assert.deepEqual(eventsOf(events, 'resumed'), [{ playerId: 'B' }]);
    assert.equal(e.pile('up').clockStart, t2 + 3000);
    assert.equal(e.phase, 'sync');
    assert.deepEqual(eventsOf(events, 'syncStart').at(-1), { reason: 'pause' });
    const t3 = syncAll(e, t2 + 4100);
    assert.equal(e.playCard('A', null, t3), true);
    assert.equal(e.lives, 3);
  });

  it('the sync hold starts when the last human puts their hand down', () => {
    const { e, events } = makeTable();
    e.start(0);
    e.placeHand('A', 100);
    e.placeHand('C', 300);
    assert.equal(e.allDownAt, null);
    assert.equal(e.nextDeadline(), null);
    e.placeHand('B', 450);
    assert.equal(e.allDownAt, 450);
    assert.deepEqual(eventsOf(events, 'allHandsDown'), [{ reason: 'level' }]);
    assert.equal(e.nextDeadline(), 450 + TIMING.syncHold);
    e.tick(450 + TIMING.syncHold - 1);
    assert.equal(e.phase, 'sync');
    e.tick(450 + TIMING.syncHold);
    assert.equal(e.phase, 'playing');
  });
});

describe('mixed tables and the offline forms', () => {
  it('with humans and a bot, the bot votes on its own and the star still needs every human', () => {
    const { e, events } = makeTable({ humans: ['A', 'B'], bots: ['x1'], seed: 3 });
    e.start(0);
    setHands(e, { A: [10, 60], B: [20, 70], x1: [50, 90] });
    const t = syncAll(e, 0);
    e.proposeStar('A', t);
    assert.ok(e.vote.pending.x1);
    const botAt = e.vote.pending.x1.at;
    assert.equal(e.nextDeadline(), botAt);
    assert.equal(e.voteStar('x1', true, t), false);
    e.tick(botAt);
    assert.deepEqual(eventsOf(events, 'starVote').map((d) => d.playerId), ['x1']);
    const botSaid = eventsOf(events, 'starVote')[0].agree;
    if (botSaid) {
      assert.equal(e.phase, 'starVote');
      assert.equal(e.nextDeadline(), t + TIMING.voteTimeout);
      e.voteStar('B', true, botAt + 10);
      assert.equal(e.phase, 'resolving');
    } else {
      assert.equal(e.phase, 'playing');
    }
  });

  it('voteStar(agree, now), pause(now) and resume(now) still act for the first human', () => {
    const { e, events, t } = setup3({ A: [10], B: [20], C: [30] });
    e.proposeStar('C', t);
    assert.equal(e.voteStar(true, t + 100), true);
    assert.deepEqual(eventsOf(events, 'starVote'), [{ playerId: 'A', agree: true }]);
    assert.equal(e.voteStar(true, t + 100), false);
    assert.equal(e.pause(t + 200), true);
    assert.equal(e.viewFor('A').pausedBy, null);
    assert.equal(e.resume(t + 700), true);
    assert.deepEqual(eventsOf(events, 'paused'), [{}]);
    assert.deepEqual(eventsOf(events, 'resumed'), [{}]);
    assert.equal(e.vote.deadline, t + TIMING.voteTimeout + 500);
  });

  it('humanPlay plays for the first human and playCard picks the pile when none is given', () => {
    const { e } = makeTable({ variant: 'dual' });
    e.start(0);
    setHands(e, { A: [{ v: 80, pile: 'down' }, { v: 30, pile: 'up' }], B: [{ v: 50, pile: 'up' }], C: [{ v: 20, pile: 'down' }] });
    const t = syncAll(e, 0);
    assert.equal(e.playCard('A', t), true);
    assert.equal(e.pile('up').top, 30);
    assert.equal(e.humanPlay('down', t + 100), true);
    assert.equal(e.pile('down').top, 80);
    assert.equal(e.playCard('C', 'up', t + 200), false);
  });
});

describe('save and restore (AC3)', () => {
  for (const variant of VARIANT_IDS) {
    for (const script of SCRIPTS[variant]) {
      it(`${variant} · ${label(script)}: restoring mid-level continues exactly like an engine that was never saved`, () => {
        const cfg = { variant, ...script };
        const base = runScripted(cfg);
        let done = false;
        const half = runScripted({
          ...cfg,
          restore: (e) => {
            if (done || e.phase !== 'playing' || e.level < 2) return false;
            const played = e.piles.reduce((s, p) => s + p.cards.length, 0);
            return (done = played * 2 >= e.players.length * e.level);
          },
        });
        assert.equal(half.restored, 1);
        assert.deepEqual(half.events, base.events);
        assert.deepEqual(half.e.toJSON(), base.e.toJSON());

        const every = runScripted({ ...cfg, restore: () => true });
        assert.ok(every.restored > 100);
        assert.deepEqual(every.events, base.events);
        assert.deepEqual(every.e.toJSON(), base.e.toJSON());
      });
    }
  }

  it('toJSON is plain JSON and covers every piece of engine state', () => {
    const { e } = makeTable({ humans: ['A', 'B'], bots: ['x1'], seed: 2 });
    const derived = ['rng', 'listeners', 'variant', 'diff', 'blind'];
    e.start(0);
    for (let t = STEP; !ENDED.includes(e.phase) && t <= MAX_T; t += STEP) {
      e.tick(t);
      policy(e, t, false);
      const json = e.toJSON();
      for (const k of Object.keys(e)) if (!derived.includes(k)) assert.ok(k in json, `toJSON misses ${k} in ${e.phase}`);
      assert.deepEqual(JSON.parse(JSON.stringify(json)), json);
    }
  });

  it('the RNG state is saved: a restored engine deals the next level like the original', () => {
    const a = makeTable({ seed: 9 }).e;
    a.start(0);
    a.tick(1);
    const b = MindEngine.fromJSON(JSON.stringify(a));
    a.placeHand('A', 5);
    b.placeHand('A', 5);
    assert.equal(snapshot(a), snapshot(b));
    for (const e of [a, b]) { e.phase = 'levelComplete'; e.nextLevel(10); }
    assert.deepEqual(a.players.map(values), b.players.map(values));
  });

  it('a restored bot plan points at the card in the restored hand', () => {
    const { e } = makeTable({ humans: ['A'], bots: ['x1', 'x2'], seed: 4 });
    e.start(0);
    syncAll(e, 0);
    const r = MindEngine.fromJSON(e.toJSON());
    for (const p of r.players) for (const id in p.plan) assert.ok(p.hand.includes(p.plan[id].card));
  });

  it('opts.seed gives the same game as opts.rng = mulberry32(seed); no seed gives a random deal', () => {
    const players = [{ id: 'A', human: true }, { id: 'B', human: true }, { id: 'C', human: true }, { id: 'D', human: true }];
    const deal = (opts) => { const e = new MindEngine({ players, ...opts }); e.start(0); return e.players.map(values); };
    assert.deepEqual(deal({ seed: 5 }), deal({ rng: mulberry32(5) }));
    assert.notDeepEqual(deal({}), deal({}));
  });

  it('refuses to save an engine whose RNG cannot be saved, and unknown state formats', () => {
    const e = new MindEngine({ players: [{ id: 'A', human: true }, { id: 'B', human: true }], rng: Math.random });
    assert.throws(() => e.toJSON(), /cannot be saved/);
    assert.throws(() => MindEngine.fromJSON({ format: 'other' }), /unsupported state format/);
  });
});

describe('privacy (AC4)', () => {
  it('the leak scan finds card values in unredacted data (so the checks below can fail)', () => {
    const { e, t } = setup3({ A: [10], B: [20], C: [30] }, { variant: 'blind' });
    assert.deepEqual(cardValues(e.toJSON()).filter((v) => v > 0 && v < 101).sort((a, b) => a - b), [10, 20, 30]);
    let raw;
    e.on('play', (d) => { raw = d; });
    e.playCard('B', null, t);
    assert.ok(cardValues(raw).includes(20));
    assert.ok(!cardValues(redactEvent('play', raw, 'A', e)).includes(20));
  });

  for (const variant of VARIANT_IDS) {
    it(`${variant}: no view or redacted event shows another player's card${variant === 'blind' ? ' or a played card before the reveal' : ''}`, () => {
      const seen = new Set();
      for (const script of SCRIPTS[variant]) {
        let revealed = false;
        let checks = 0;
        runScripted({
          variant,
          ...script,
          onEvent: (type, data, e) => {
            if (type === 'levelStart') revealed = false;
            if (type === 'reveal') revealed = true;
            seen.add(type);
            const played = e.blind && !revealed ? new Set(e.piles.flatMap((p) => p.cards.map((c) => c.v))) : new Set();
            const viewers = e.players.filter((p) => p.human).map((p) => p.id).concat(null);
            for (const viewer of viewers) {
              const foreign = new Set(e.players.filter((p) => p.id !== viewer).flatMap(values));
              const event = redactEvent(type, data, viewer, e);
              if (type === 'play' && e.blind) assert.deepEqual([event.card.v, event.top, event.gap], [null, null, null]);
              for (const [what, payload] of [['event', event], ['view', e.viewFor(viewer)]]) {
                for (const v of cardValues(payload)) {
                  assert.ok(!foreign.has(v), `${what} '${type}' for ${viewer} shows ${v} from another player's hand (${label(script)})`);
                  assert.ok(!played.has(v), `${what} '${type}' for ${viewer} shows played Blind card ${v} before the reveal (${label(script)})`);
                }
                checks++;
              }
            }
          },
        });
        assert.ok(checks > 300);
      }
      const notInVariant = variant === 'blind' ? ['perfectSync', 'mistake', 'refocusCalled'] : ['reveal'];
      assert.deepEqual([...seen].sort(), ALL_EVENTS.filter((x) => !notInVariant.includes(x)).sort());
    });
  }
});

describe('viewFor', () => {
  it('shows the public table and only the viewer\'s own hand', () => {
    const { e, t } = setup3({ A: [10, 60], B: [20, 70], C: [30, 80] });
    e.playCard('A', null, t);
    const v = e.viewFor('B');
    assert.equal(v.you, 'B');
    assert.deepEqual(v.hand, [{ v: 20, pile: 'up' }, { v: 70, pile: 'up' }]);
    assert.deepEqual(v.players.map((p) => [p.id, p.seat, p.handCount, p.handDown]), [['A', 0, 1, false], ['B', 1, 2, false], ['C', 2, 2, false]]);
    assert.deepEqual(v.piles, [{ id: 'up', dir: 1, count: 1, top: 10, cards: [{ v: 10, by: 'A', at: t }] }]);
    assert.deepEqual(v.lastPlay, { by: 'A', pile: 'up', at: t, v: 10 });
    assert.deepEqual([v.phase, v.level, v.maxLevel, v.lives, v.stars, v.variant], ['playing', 1, 10, 3, 1, 'classic']);
    assert.equal(e.viewFor(null).hand, null);
    assert.equal(e.viewFor('nobody').hand, null);
    assert.equal(e.viewFor('nobody').you, null);
    assert.ok(!('rngState' in v) && !('players' in v && v.players.some((p) => 'hand' in p)));
  });

  it('in Blind, pile values stay hidden until the reveal', () => {
    const { e, t } = setup3({ A: [10], B: [20], C: [30] }, { variant: 'blind' });
    e.playCard('B', null, t);
    e.playCard('A', null, t + 100);
    let v = e.viewFor('C');
    assert.deepEqual(v.piles[0].cards.map((c) => [c.v, c.by]), [[null, 'B'], [null, 'A']]);
    assert.equal(v.piles[0].top, null);
    assert.equal(v.lastPlay.v, null);
    e.playCard('C', null, t + 200);
    v = e.viewFor('C');
    assert.deepEqual(v.piles[0].cards.map((c) => c.v), [20, 10, 30]);
    assert.equal(v.piles[0].top, 30);
    e.tick(e.nextDeadline());
    e.nextLevel(e.stats.endedAt || 100000);
    assert.equal(e.viewFor('A').piles[0].top, null);
  });

  it('shows the votes cast but not what a bot is going to vote, plus the current deadline', () => {
    const { e } = makeTable({ humans: ['A', 'B'], bots: ['x1'], seed: 3 });
    e.start(0);
    setHands(e, { A: [10], B: [20], x1: [90] });
    const t = syncAll(e, 0);
    e.proposeStar('A', t);
    const v = e.viewFor('B');
    assert.deepEqual(v.vote, { proposer: 'A', votes: { A: true }, deadline: t + TIMING.voteTimeout, startedAt: t });
    assert.deepEqual(v.deadlines, { syncHold: null, resolve: null, vote: t + TIMING.voteTimeout });
    assert.ok(!JSON.stringify(v).includes('pending'));
  });
});

describe('redactEvent', () => {
  it('hides a Blind play and keeps other public events as they are', () => {
    const blindPlay = { playerId: 'B', card: { v: 42, pile: 'up' }, pileId: 'up', blind: true, top: 0, count: 1, gap: 42, elapsed: 900 };
    assert.deepEqual(redactEvent('play', blindPlay, 'A'), { ...blindPlay, card: { v: null, pile: 'up' }, top: null, gap: null });
    assert.equal(blindPlay.card.v, 42);
    const open = { playerId: 'B', card: { v: 42, pile: 'up' }, pileId: 'up', blind: false, top: 42, count: 1, gap: 30, elapsed: 900 };
    assert.deepEqual(redactEvent('play', open, 'A'), open);
    const mistake = { playerId: 'B', card: { v: 40, pile: 'up' }, offenders: [{ playerId: 'A', cards: [10] }], lives: 2 };
    const star = { discards: [{ playerId: 'A', v: 10, pile: 'up' }], stars: 0 };
    const reveal = { results: [{ pile: 'up', index: 0, v: 30, by: 'A', ok: true }], wrong: 0, lives: 3 };
    assert.deepEqual(redactEvent('mistake', mistake, 'C'), mistake);
    assert.deepEqual(redactEvent('star', star, 'C'), star);
    assert.deepEqual(redactEvent('reveal', reveal, 'C'), reveal);
  });

  it('removes every hand that is not the viewer\'s', () => {
    const data = { level: 1, hands: { A: [5], B: [7] }, players: [{ id: 'A', hand: [5] }, { playerId: 'B', hand: [{ v: 7 }] }] };
    assert.deepEqual(redactEvent('levelStart', data, 'A'), { level: 1, hands: { A: [5] }, players: [{ id: 'A', hand: [5] }, { playerId: 'B', hand: null }] });
    assert.deepEqual(redactEvent('levelStart', data, null), { level: 1, hands: {}, players: [{ id: 'A', hand: null }, { playerId: 'B', hand: null }] });
    assert.deepEqual(data.hands, { A: [5], B: [7] });
  });
});

describe('nextDeadline and idle ticks (AC5)', () => {
  it('sync: the earliest bot hand, then the end of the hold; null while only humans are missing', () => {
    const { e } = makeTable({ humans: ['A'], bots: ['x1', 'x2'], seed: 6 });
    e.start(0);
    const bots = e.players.filter((p) => !p.human);
    assert.equal(e.nextDeadline(), Math.min(...bots.map((p) => p.handDownAt)));
    e.tick(2000);
    assert.ok(bots.every((p) => p.handDown));
    assert.equal(e.nextDeadline(), null);
    e.placeHand('A', 2100);
    assert.equal(e.nextDeadline(), 2100 + TIMING.syncHold);
  });

  it('playing: the next bot play; null with humans only', () => {
    const mixed = makeTable({ humans: ['A'], bots: ['x1'], seed: 6 }).e;
    mixed.start(0);
    setHands(mixed, { A: [90], x1: [10] });
    const t = syncAll(mixed, 0);
    assert.equal(mixed.nextDeadline(), mixed.player('x1').plan.up.at);
    assert.ok(mixed.nextDeadline() > t);
    const humansOnly = setup3({ A: [10], B: [20], C: [30] });
    assert.equal(humansOnly.e.nextDeadline(), null);
  });

  it('resolving: the end of the pause; starVote: the vote deadline', () => {
    const { e, t } = setup3({ A: [40], B: [10, 50], C: [60] });
    e.playCard('A', null, t);
    assert.equal(e.phase, 'resolving');
    assert.equal(e.nextDeadline(), t + TIMING.mistakePause);
    e.tick(t + TIMING.mistakePause);
    const t2 = syncAll(e, t + TIMING.mistakePause + 10);
    e.proposeStar('B', t2);
    assert.equal(e.nextDeadline(), t2 + TIMING.voteTimeout);
  });

  it('null while waiting for a player: before start, paused, level complete, game over', () => {
    const { e } = makeTable();
    assert.equal(e.nextDeadline(), null);
    e.start(0);
    setHands(e, { A: [50] });
    const t = syncAll(e, 0);
    e.pause('B', t);
    assert.equal(e.nextDeadline(), null);
    e.resume('C', t + 10);
    syncAll(e, t + 20);
    e.playCard('A', null, t + 5000);
    assert.equal(e.phase, 'levelComplete');
    assert.equal(e.nextDeadline(), null);
    e.lives = 1;
    e.nextLevel(t + 6000);
    setHands(e, { A: [60], B: [5] });
    const t2 = syncAll(e, t + 6000);
    e.playCard('A', null, t2);
    e.tick(e.nextDeadline());
    assert.equal(e.phase, 'gameOver');
    assert.equal(e.nextDeadline(), null);
  });

  for (const variant of VARIANT_IDS) {
    it(`${variant}: tick before nextDeadline() changes nothing, tick at it always changes the state`, () => {
      let due = 0;
      for (const script of SCRIPTS[variant]) due += runScripted({ variant, ...script, checkTick: true }).dueTicks;
      assert.ok(due > 50);
    });
  }
});

describe('invalid actions (AC6)', () => {
  function expectRefused(e, calls) {
    for (const [name, fn] of calls) {
      const before = snapshot(e);
      let result;
      assert.doesNotThrow(() => { result = fn(); }, name);
      assert.equal(result, false, name);
      assert.equal(snapshot(e), before, `${name} changed the state`);
    }
  }

  it('wrong phase, unknown player, no card, unknown pile, bot moves', () => {
    const { e } = makeTable({ humans: ['A', 'B'], bots: ['x1'], seed: 8 });
    expectRefused(e, [
      ['play before start', () => e.playCard('A', null, 0)],
      ['hand down before start', () => e.placeHand('A', 0)],
      ['pause before start', () => e.pause('A', 0)],
      ['nextLevel before start', () => e.nextLevel(0)],
    ]);
    e.start(0);
    setHands(e, { A: [10], B: [], x1: [90] });
    expectRefused(e, [
      ['play during sync', () => e.playCard('A', null, 10)],
      ['star during sync', () => e.proposeStar('A', 10)],
      ['vote outside a vote', () => e.voteStar('A', true, 10)],
      ['refocus during sync', () => e.callRefocus('A', 10)],
      ['resume when not paused', () => e.resume('A', 10)],
      ['nextLevel before the level is complete', () => e.nextLevel(10)],
      ['unknown player puts hand down', () => e.placeHand('nobody', 10)],
    ]);
    e.placeHand('A', 10);
    expectRefused(e, [['second hand down', () => e.placeHand('A', 20)]]);
    const t = syncAll(e, 30);
    expectRefused(e, [
      ['hand down while playing', () => e.placeHand('B', t)],
      ['unknown player plays', () => e.playCard('nobody', null, t)],
      ['player without cards plays', () => e.playCard('B', null, t)],
      ['unknown pile', () => e.playCard('A', 'down', t)],
      ['bot moved from outside', () => e.playCard('x1', null, t)],
      ['unknown player proposes a star', () => e.proposeStar('nobody', t)],
      ['unknown player calls refocus', () => e.callRefocus('nobody', t)],
      ['unknown player pauses', () => e.pause('nobody', t)],
      ['vote outside a vote', () => e.voteStar('B', true, t)],
      ['nextLevel while playing', () => e.nextLevel(t)],
    ]);
    e.proposeStar('A', t);
    expectRefused(e, [
      ['proposer votes again', () => e.voteStar('A', false, t + 10)],
      ['bot vote from outside', () => e.voteStar('x1', false, t + 10)],
      ['unknown voter', () => e.voteStar('nobody', true, t + 10)],
      ['second proposal', () => e.proposeStar('B', t + 10)],
      ['play during the vote', () => e.playCard('A', null, t + 10)],
    ]);
    e.voteStar('B', true, t + 20);
    expectRefused(e, [['second vote', () => e.voteStar('B', true, t + 30)]]);
  });

  it('no stars left, paused, finished, and garbage arguments never throw', () => {
    const { e, t } = setup3({ A: [10, 50], B: [20], C: [30] });
    e.stars = 0;
    expectRefused(e, [['star with no stars left', () => e.proposeStar('A', t)]]);
    e.pause('A', t + 10);
    expectRefused(e, [
      ['pause twice', () => e.pause('B', t + 20)],
      ['play while paused', () => e.playCard('A', null, t + 20)],
      ['refocus while paused', () => e.callRefocus('A', t + 20)],
      ['unknown player resumes', () => e.resume('nobody', t + 20)],
    ]);
    expectRefused(e, [
      ['playCard()', () => e.playCard()],
      ['playCard({})', () => e.playCard({}, {}, {})],
      ['placeHand(NaN)', () => e.placeHand(NaN, NaN)],
      ['voteStar(null)', () => e.voteStar(null, 'yes', 0)],
      ['voteStar({})', () => e.voteStar({}, true, 0)],
      ['pause()', () => e.pause()],
      ['resume(undefined, 1)', () => e.resume(undefined, 1)],
      ['proposeStar([])', () => e.proposeStar([], 0)],
      ['callRefocus({})', () => e.callRefocus({}, 0)],
      ['nextLevel()', () => e.nextLevel()],
    ]);
    e.resume('B', t + 100);
    e.phase = 'victory';
    expectRefused(e, [['pause after the game', () => e.pause('A', t + 200)], ['nextLevel after victory', () => e.nextLevel(t + 200)]]);
  });
});
