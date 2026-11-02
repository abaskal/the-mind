// MIND-04 · room-action core with an in-memory repository: fair ordering (AC1), multi-player flows (AC3),
// idempotent tick (AC4), authorization (AC6), retries, rate limit and the HTTP contract.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createRoomActionService, createActionRateLimiter, END_GAME_AFTER_PAUSE_MS, MAX_CONFLICT_RETRIES,
} from '../supabase/functions/_shared/room-action.mjs';
import { createMemoryRoomActionRepo } from '../supabase/functions/_shared/room-action-memory-repo.mjs';
import { createRoomActionHandler, serverTimingHeader } from '../supabase/functions/_shared/room-action-http.mjs';

const Mind = createRequire(import.meta.url)('../engine/mind-engine.js');
const { MindEngine, TIMING } = Mind;

const user = (n) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const ROOM = '33333333-3333-4333-8333-000000000001';
const [A, B, C, D, X] = [1, 2, 3, 4, 9].map(user);
const SEATED = [A, B, C, D];
const T0 = 1_000_000;

// A fresh table: A hosts, seats 0..n-1, a fixed seed, no rate limit unless asked for.
function table({ players = 3, variant = 'classic', seed = 7, maxRetries, rateLimiter = { allow: () => true } } = {}) {
  const tb = { t: T0 };
  tb.repo = createMemoryRoomActionRepo({ now: () => tb.t });
  tb.repo.addRoom({
    id: ROOM, hostId: A, variant,
    players: SEATED.slice(0, players).map((userId, seat) => ({ userId, seat, nickname: 'ABCD'[seat] })),
  });
  tb.svc = createRoomActionService({ repo: tb.repo, Mind, randomSeed: () => seed, maxRetries, rateLimiter });
  tb.room = () => tb.repo.room(ROOM);
  tb.engine = () => MindEngine.fromJSON(tb.room().engineState);
  tb.send = (u, type, extra = {}) => tb.svc.run(u, { roomId: ROOM, type, ...extra });
  tb.ok = async (u, type, extra) => {
    const r = await tb.send(u, type, extra);
    assert.equal(r.status, 200, `${type}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  tb.err = async (u, type, extra) => {
    const r = await tb.send(u, type, extra);
    assert.notEqual(r.status, 200, `${type} should fail`);
    return { status: r.status, code: r.body.error.code, body: r.body };
  };
  // Test setup only: edits the stored engine state (and the hand rows) as if it had been dealt that way.
  tb.edit = (fn) => {
    const e = tb.engine();
    fn(e);
    tb.room().engineState = e.toJSON();
    for (const p of e.players) {
      const userId = SEATED[Number(p.id.slice(1))];
      tb.room().hands.set(userId, { hand: p.hand.map((c) => ({ v: c.v, pile: c.pile })), version: tb.room().version });
    }
  };
  tb.setHands = (hands) => tb.edit((e) => {
    assert.equal(e.phase, 'sync');
    for (const p of e.players) p.hand = (hands[p.id] || []).map((v) => ({ v, pile: e.piles[0].id }));
  });
  tb.seated = () => SEATED.slice(0, players);
  // start → (hands) → every hand down → the sync hold runs out → playing.
  tb.startAndPlay = async (hands) => {
    await tb.ok(A, 'start');
    if (hands) tb.setHands(hands);
    for (const u of tb.seated()) await tb.ok(u, 'handDown');
    tb.t += TIMING.syncHold;
    assert.equal((await tb.ok(A, 'tick')).view.phase, 'playing');
  };
  // Whoever holds the lowest card plays it, 1.5 s apart, until the level ends (Classic, no mistakes).
  tb.playLevel = async () => {
    let last;
    for (let e = tb.engine(); e.phase === 'playing'; e = tb.engine()) {
      const holder = e.players.filter((p) => p.hand.length).sort((a, b) => a.hand[0].v - b.hand[0].v)[0];
      tb.t += 1500;
      last = await tb.ok(SEATED[holder.seat], 'play');
    }
    return last;
  };
  return tb;
}

// Holds the first n loads until all n have happened, so they all read the same version.
function gateLoads(repo, n) {
  const original = repo.loadRoomForAction;
  let arrived = 0;
  let open;
  const allLoaded = new Promise((resolve) => { open = resolve; });
  repo.loadRoomForAction = async (...args) => {
    const loaded = await original(...args);
    if (arrived < n) {
      if (++arrived === n) open();
      await allLoaded;
    }
    return loaded;
  };
  return () => { repo.loadRoomForAction = original; };
}

const types = (events) => events.map((e) => e.type);

describe('fair ordering (AC1)', () => {
  it('two plays loaded at the same version both apply, in commit order; the second is retried exactly once', async () => {
    const tb = table();
    await tb.startAndPlay({ s0: [10, 50], s1: [20, 60], s2: [70] });
    tb.t += 2000;
    const before = { ...tb.repo.stats };
    const restore = gateLoads(tb.repo, 2);
    const [ra, rb] = await Promise.all([tb.send(A, 'play'), tb.send(B, 'play')]);
    restore();
    assert.deepEqual([ra.status, rb.status], [200, 200]);
    assert.deepEqual(
      [tb.repo.stats.loads - before.loads, tb.repo.stats.commits - before.commits, tb.repo.stats.conflicts - before.conflicts],
      [3, 2, 1],
    );
    assert.equal(rb.body.version, ra.body.version + 1);
    assert.deepEqual(tb.engine().piles[0].cards.map((c) => [c.v, c.by]), [[10, 's0'], [20, 's1']]);
    assert.equal(tb.engine().lives, 3);
    assert.deepEqual(tb.room().events.map((e) => e.seq), tb.room().events.map((_, i) => i + 1));
  });

  it('B commits 60 while A still holds 42: a mistake, 42 is discarded, the team loses 1 life', async () => {
    const tb = table();
    await tb.startAndPlay({ s0: [42, 90], s1: [60], s2: [75] });
    tb.t += 3000;
    const r = await tb.ok(B, 'play');
    const mistake = r.events.find((e) => e.type === 'mistake');
    assert.deepEqual(mistake.data.offenders, [{ playerId: 's0', cards: [42] }]);
    assert.deepEqual([r.view.lives, r.view.phase], [2, 'resolving']);
    assert.deepEqual(tb.engine().player('s0').hand.map((c) => c.v), [90]);
    assert.deepEqual(tb.engine().discard.map((d) => [d.v, d.by, d.reason]), [[42, 's0', 'mistake']]);
    assert.deepEqual(tb.room().hands.get(A).hand.map((c) => c.v), [90], "A's own hand row lost 42");
  });

  it('a play that loses the race to a mistake is rejected on its retry, not moved to the next card', async () => {
    const tb = table();
    await tb.startAndPlay({ s0: [42, 90], s1: [60], s2: [75] });
    tb.t += 3000;
    const restore = gateLoads(tb.repo, 2);
    const [rb, ra] = await Promise.all([tb.send(B, 'play'), tb.send(A, 'play')]);
    restore();
    assert.equal(rb.status, 200);
    assert.deepEqual([ra.status, ra.body.error.code], [409, 'INVALID_MOVE']);
    assert.deepEqual(tb.engine().player('s0').hand.map((c) => c.v), [90]);
    assert.equal(tb.engine().lives, 2);
  });
});

describe('multi-player flows (AC3)', () => {
  it('start → every hand down → the sync hold passes through tick → playing', async () => {
    const tb = table();
    const s = await tb.ok(A, 'start');
    assert.deepEqual([s.status, s.view.phase, s.view.level, s.view.you, s.view.lives, s.view.stars], ['playing', 'sync', 1, 's0', 3, 1]);
    assert.deepEqual(s.view.players.map((p) => [p.id, p.name, p.human]), [['s0', 'A', true], ['s1', 'B', true], ['s2', 'C', true]]);
    assert.deepEqual(types(s.events), ['levelStart', 'syncStart']);
    assert.equal(tb.room().status, 'playing');
    assert.equal(tb.room().hands.size, 3);
    assert.equal(tb.engine().adapt, false);

    await tb.ok(A, 'handDown');
    await tb.ok(B, 'handDown');
    const last = await tb.ok(C, 'handDown');
    assert.deepEqual(types(last.events), ['handDown', 'allHandsDown']);
    assert.equal(last.nextDeadlineAt, tb.t + TIMING.syncHold);
    assert.equal(tb.room().nextDeadlineAt, last.nextDeadlineAt);

    tb.t += TIMING.syncHold - 1;
    const early = await tb.ok(B, 'tick');
    assert.deepEqual([early.view.phase, early.events], ['sync', []]);
    tb.t += 1;
    const go = await tb.ok(B, 'tick');
    assert.deepEqual([go.view.phase, types(go.events), go.nextDeadlineAt], ['playing', ['playing'], null]);
  });

  it('a full level with a reward: level 2 gives a star', async () => {
    const tb = table();
    await tb.startAndPlay();
    const one = await tb.playLevel();
    assert.equal(one.view.phase, 'levelComplete');
    await tb.ok(C, 'nextLevel');
    for (const u of [A, B, C]) await tb.ok(u, 'handDown');
    tb.t += TIMING.syncHold;
    await tb.ok(A, 'tick');
    const two = await tb.playLevel();
    const done = two.events.find((e) => e.type === 'levelComplete').data;
    assert.deepEqual([done.level, done.reward, done.applied, done.stars], [2, 'star', true, 2]);
    assert.deepEqual([two.view.level, two.view.stars, two.view.lives, two.view.stats.levelsCleared], [2, 2, 3, 2]);
    assert.equal(tb.room().publicState.stars, 2);
  });

  it('star vote: everyone says yes', async () => {
    const tb = table();
    await tb.startAndPlay({ s0: [10, 30], s1: [20], s2: [40] });
    const p = await tb.ok(B, 'proposeStar');
    assert.deepEqual([p.view.phase, p.view.vote.proposer], ['starVote', 's1']);
    await tb.ok(A, 'voteStar', { agree: true });
    const r = await tb.ok(C, 'voteStar', { agree: true });
    const star = r.events.find((e) => e.type === 'star').data;
    assert.deepEqual(star.discards.map((d) => [d.playerId, d.v]), [['s0', 10], ['s1', 20], ['s2', 40]]);
    assert.equal(r.view.stars, 0);
    assert.equal((await tb.err(A, 'voteStar', { agree: true })).code, 'INVALID_MOVE');
  });

  it('star vote: one no rejects it', async () => {
    const tb = table();
    await tb.startAndPlay({ s0: [10, 30], s1: [20], s2: [40] });
    await tb.ok(A, 'proposeStar');
    await tb.ok(B, 'voteStar', { agree: true });
    const r = await tb.ok(C, 'voteStar', { agree: false });
    assert.deepEqual(types(r.events), ['starVote', 'starRejected', 'playing']);
    assert.deepEqual([r.view.phase, r.view.stars], ['playing', 1]);
  });

  it('star vote: a missing vote times out through tick after TIMING.voteTimeout', async () => {
    const tb = table();
    await tb.startAndPlay({ s0: [10, 30], s1: [20], s2: [40] });
    const p = await tb.ok(A, 'proposeStar');
    assert.equal(p.nextDeadlineAt, tb.t + TIMING.voteTimeout);
    await tb.ok(B, 'voteStar', { agree: true });
    tb.t += TIMING.voteTimeout - 1;
    assert.deepEqual((await tb.ok(B, 'tick')).events, []);
    tb.t += 1;
    const r = await tb.ok(B, 'tick');
    assert.deepEqual(r.events.slice(0, 2).map((e) => [e.type, e.data.playerId || e.data.by, e.data.agree, e.data.timeout]), [
      ['starVote', 's2', false, true], ['starRejected', 's2', undefined, undefined],
    ]);
    assert.equal(r.view.phase, 'playing');
  });

  it('refocus; pause by one player and resume by another', async () => {
    const tb = table();
    await tb.startAndPlay();
    const rf = await tb.ok(C, 'refocus');
    assert.deepEqual([types(rf.events), rf.view.phase, rf.view.syncReason], [['refocusCalled', 'syncStart'], 'sync', 'refocus']);
    for (const u of [A, B, C]) await tb.ok(u, 'handDown');
    tb.t += TIMING.syncHold;
    await tb.ok(A, 'tick');

    const pa = await tb.ok(A, 'pause');
    assert.deepEqual([pa.view.phase, pa.view.pausedBy, pa.nextDeadlineAt], ['paused', 's0', null]);
    assert.equal((await tb.err(C, 'play')).code, 'INVALID_MOVE');
    tb.t += 5000;
    const re = await tb.ok(B, 'resume');
    assert.deepEqual(re.events.map((e) => [e.type, e.data.playerId]), [['resumed', 's1'], ['syncStart', undefined]]);
    assert.equal(re.view.phase, 'sync');
  });

  it('endGame is rejected before 3 minutes of pause and accepted after', async () => {
    const tb = table();
    await tb.startAndPlay();
    await tb.ok(B, 'pause');
    tb.t += END_GAME_AFTER_PAUSE_MS - 1;
    const early = await tb.err(C, 'endGame');
    assert.deepEqual([early.status, early.code], [409, 'INVALID_MOVE']);
    assert.equal(tb.room().status, 'playing');
    tb.t += 1;
    const r = await tb.ok(C, 'endGame');
    assert.equal(r.status, 'abandoned');
    assert.deepEqual(r.events.map((e) => [e.type, e.data]), [['gameAborted', { by: 's2', reason: 'endGame' }]]);
    assert.deepEqual([tb.room().status, tb.room().nextDeadlineAt], ['abandoned', null]);
    assert.equal((await tb.err(A, 'resume')).code, 'INVALID_MOVE');
  });

  it('endGame is rejected while the game is not paused', async () => {
    const tb = table();
    await tb.startAndPlay();
    tb.t += END_GAME_AFTER_PAUSE_MS * 2;
    assert.equal((await tb.err(A, 'endGame')).code, 'INVALID_MOVE');
  });

  it('game over sets the room finished with a result; rematch returns to the lobby and the next start resets', async () => {
    const tb = table({ variant: 'reverse' });
    await tb.startAndPlay({ s0: [50], s1: [40], s2: [30] });
    tb.edit((e) => { e.lives = 1; });
    tb.t += 2000;
    const mistake = await tb.ok(C, 'play');
    assert.deepEqual([mistake.view.phase, mistake.view.lives], ['resolving', 0]);
    tb.t += TIMING.mistakePause;
    const over = await tb.ok(A, 'tick');
    assert.deepEqual([over.status, over.view.phase, types(over.events)], ['finished', 'gameOver', ['gameOver']]);
    assert.deepEqual(tb.room().publicState.result, {
      won: false, level: 1, maxLevel: 10, stats: tb.engine().stats, variant: 'reverse',
    });
    assert.equal(tb.room().nextDeadlineAt, null);
    assert.equal((await tb.err(B, 'tick')).code, 'INVALID_MOVE');
    assert.equal((await tb.err(B, 'rematch')).code, 'NOT_HOST');

    const re = await tb.ok(A, 'rematch');
    assert.deepEqual([re.status, re.view, types(re.events)], ['lobby', null, ['rematch']]);
    assert.deepEqual([tb.room().status, tb.room().engineState, tb.room().hands.size, tb.room().publicState], ['lobby', null, 0, null]);
    assert.deepEqual(tb.room().players.map((p) => p.userId), [A, B, C]);

    const again = await tb.ok(A, 'start');
    assert.deepEqual([again.view.level, again.view.lives, again.view.stars, again.view.phase], [1, 3, 1, 'sync']);
    assert.deepEqual(again.view.stats.mistakes, 0);
    assert.equal(tb.room().hands.size, 3);
  });
});

describe('idempotent tick (AC4)', () => {
  it('a tick with nothing due writes nothing, in every waiting phase', async () => {
    const tb = table();
    await tb.ok(A, 'start');
    const check = async (phase) => {
      const { commits } = tb.repo.stats;
      const version = tb.room().version;
      const r = await tb.ok(B, 'tick');
      assert.deepEqual([r.view.phase, r.events, r.version], [phase, [], version]);
      assert.equal(tb.repo.stats.commits, commits, `tick in ${phase} wrote`);
    };
    await check('sync');
    for (const u of [A, B, C]) await tb.ok(u, 'handDown');
    tb.t += 100;
    await check('sync');
    tb.t += TIMING.syncHold;
    await tb.ok(A, 'tick');
    tb.t += 60_000;
    await check('playing');
    await tb.ok(A, 'pause');
    tb.t += 60_000;
    await check('paused');
  });

  it('four players ticking at the same deadline make exactly one state transition', async () => {
    const tb = table({ players: 4 });
    await tb.ok(A, 'start');
    for (const u of [A, B, C, D]) await tb.ok(u, 'handDown');
    tb.t += TIMING.syncHold;
    const before = { ...tb.repo.stats };
    const eventsBefore = tb.room().events.length;
    const restore = gateLoads(tb.repo, 4);
    const replies = await Promise.all([A, B, C, D].map((u) => tb.send(u, 'tick')));
    restore();
    assert.deepEqual(replies.map((r) => r.status), [200, 200, 200, 200]);
    assert.equal(tb.repo.stats.commits - before.commits, 1);
    assert.equal(tb.repo.stats.conflicts - before.conflicts, 3);
    assert.deepEqual(tb.room().events.slice(eventsBefore).map((e) => e.type), ['playing']);
    assert.ok(replies.every((r) => r.body.view.phase === 'playing'));
    assert.equal(new Set(replies.map((r) => r.body.version)).size, 1);
  });
});

describe('authorization (AC6)', () => {
  it('a non-member gets 403 NOT_A_MEMBER for every action, and so does an unknown room', async () => {
    const tb = table();
    await tb.ok(A, 'start');
    for (const type of ['start', 'handDown', 'play', 'tick', 'rematch', 'endGame']) {
      const e = await tb.err(X, type);
      assert.deepEqual([e.status, e.code], [403, 'NOT_A_MEMBER'], type);
    }
    const unknown = await tb.svc.run(A, { roomId: user(77), type: 'tick' });
    assert.deepEqual([unknown.status, unknown.body.error.code], [403, 'NOT_A_MEMBER']);
    tb.room().players.find((p) => p.userId === C).leftAt = tb.t;
    assert.equal((await tb.err(C, 'tick')).code, 'NOT_A_MEMBER');
  });

  it('only the host can start or rematch: 403 NOT_HOST', async () => {
    const tb = table();
    const e = await tb.err(B, 'start');
    assert.deepEqual([e.status, e.code], [403, 'NOT_HOST']);
    assert.equal(tb.room().status, 'lobby');
    assert.equal((await tb.err(C, 'rematch')).code, 'NOT_HOST');
  });

  it('abandoned or finished rooms refuse every action except rematch with 409 INVALID_MOVE', async () => {
    for (const status of ['abandoned', 'finished']) {
      const tb = table();
      await tb.startAndPlay();
      tb.room().status = status;
      for (const type of ['start', 'handDown', 'play', 'proposeStar', 'voteStar', 'refocus', 'pause', 'resume', 'nextLevel', 'tick', 'endGame']) {
        const e = await tb.err(A, type, type === 'voteStar' ? { agree: true } : {});
        assert.deepEqual([e.status, e.code], [409, 'INVALID_MOVE'], `${status} ${type}`);
      }
      const rematch = await tb.send(A, 'rematch');
      assert.equal(rematch.status, status === 'finished' ? 200 : 409, status);
    }
  });

  it('a lobby only accepts start, with 2–4 players', async () => {
    const tb = table();
    for (const type of ['handDown', 'play', 'tick', 'rematch', 'endGame']) assert.equal((await tb.err(A, type)).code, 'INVALID_MOVE', type);
    const solo = table({ players: 1 });
    const e = await solo.err(A, 'start');
    assert.deepEqual([e.status, e.code, solo.room().status], [409, 'INVALID_MOVE', 'lobby']);
  });
});

describe('invalid moves, input and retries', () => {
  it('an invalid move returns 409 with the view, version and server time, and writes nothing', async () => {
    const tb = table();
    await tb.startAndPlay({ s0: [10], s1: [20], s2: [] });
    const { commits } = tb.repo.stats;
    const e = await tb.err(C, 'play');
    assert.equal(e.status, 409);
    assert.deepEqual(Object.keys(e.body).sort(), ['error', 'nextDeadlineAt', 'serverNow', 'version', 'view']);
    assert.deepEqual([e.body.view.you, e.body.view.hand, e.body.version, e.body.serverNow], ['s2', [], tb.room().version, tb.t]);
    assert.equal(tb.repo.stats.commits, commits);
  });

  it('a due tick is still committed when the action itself is not possible', async () => {
    const tb = table();
    await tb.ok(A, 'start');
    for (const u of [A, B, C]) await tb.ok(u, 'handDown');
    tb.t += TIMING.syncHold;
    const version = tb.room().version;
    const e = await tb.err(A, 'nextLevel');
    assert.equal(e.code, 'INVALID_MOVE');
    assert.deepEqual([e.body.version, e.body.view.phase, tb.room().version], [version + 1, 'playing', version + 1]);
  });

  it('bad input gets 400 INVALID_INPUT', async () => {
    const tb = table();
    const cases = [
      null, [], {}, { roomId: 'x', type: 'tick' }, { roomId: ROOM }, { roomId: ROOM, type: 'cheat' },
      { roomId: ROOM, type: '__proto__' }, { roomId: ROOM, type: 'play', pileId: 3 },
      { roomId: ROOM, type: 'voteStar' }, { roomId: ROOM, type: 'voteStar', agree: 'yes' },
    ];
    for (const body of cases) {
      const r = await tb.svc.run(A, body);
      assert.deepEqual([r.status, r.body.error.code], [400, 'INVALID_INPUT'], JSON.stringify(body));
    }
    assert.equal((await tb.svc.run('nope', { roomId: ROOM, type: 'tick' })).status, 401);
  });

  it(`gives up after ${MAX_CONFLICT_RETRIES} retries with 409 CONFLICT_RETRY and nothing written`, async () => {
    const tb = table();
    await tb.startAndPlay();
    const commit = tb.repo.commitRoomAction;
    let calls = 0;
    tb.repo.commitRoomAction = async () => { calls++; return { conflict: true }; };
    const version = tb.room().version;
    const e = await tb.err(A, 'pause');
    tb.repo.commitRoomAction = commit;
    assert.deepEqual([e.status, e.code, calls, tb.room().version], [409, 'CONFLICT_RETRY', MAX_CONFLICT_RETRIES + 1, version]);
  });

  it('only changed hands are written, each to its owner', async () => {
    const tb = table();
    await tb.startAndPlay({ s0: [10, 30], s1: [20], s2: [40] });
    const versions = () => [A, B, C].map((u) => tb.room().hands.get(u).version);
    const before = versions();
    tb.t += 1000;
    await tb.ok(A, 'play');
    const after = versions();
    assert.ok(after[0] > before[0]);
    assert.deepEqual(after.slice(1), before.slice(1));
    assert.deepEqual(tb.room().hands.get(A).hand, [{ v: 30, pile: 'up' }]);
  });

  it('a new game gets a fresh 32-bit seed from the injected source; the default uses crypto', async () => {
    const tb = table({ seed: 0xdeadbeef });
    await tb.ok(A, 'start');
    const repo = createMemoryRoomActionRepo({ now: () => T0 });
    repo.addRoom({ id: ROOM, hostId: A, players: [{ userId: A, seat: 0, nickname: 'A' }, { userId: B, seat: 1, nickname: 'B' }] });
    const svc = createRoomActionService({ repo, Mind });
    assert.equal((await svc.run(A, { roomId: ROOM, type: 'start' })).status, 200);
    const state = repo.room(ROOM).engineState;
    assert.ok(Number.isInteger(state.rngState) && state.rngState >= 0 && state.rngState < 2 ** 32);
  });
});

describe('rate limit', () => {
  it('at most 15 actions per second per user (per instance)', async () => {
    let now = 0;
    const tb = table({ rateLimiter: createActionRateLimiter({ now: () => now }) });
    await tb.ok(A, 'start');
    for (let i = 0; i < 14; i++) await tb.ok(A, 'tick');
    const limited = await tb.err(A, 'tick');
    assert.deepEqual([limited.status, limited.code], [429, 'RATE_LIMITED']);
    await tb.ok(B, 'tick');
    now += 1000;
    await tb.ok(A, 'tick');
  });
});

describe('HTTP handler', () => {
  const tokens = { 'Bearer a-token': A, 'Bearer x-token': X };
  const handlerFor = (tb, extra = {}) => createRoomActionHandler({
    service: tb.svc,
    authenticate: async (req) => tokens[req.headers.get('Authorization')] || null,
    log: { error: () => {} },
    ...extra,
  });
  const post = (handler, body, token = 'a-token') => handler(new Request('http://x/room-action', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));

  it('returns the action result with CORS and Server-Timing (load, engine, commit, total)', async () => {
    const tb = table();
    const res = await post(handlerFor(tb), { roomId: ROOM, type: 'start' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(res.headers.get('Server-Timing'), /^load;dur=\d+\.\d, engine;dur=\d+\.\d, commit;dur=\d+\.\d, total;dur=\d+\.\d$/);
    assert.match(res.headers.get('Access-Control-Expose-Headers'), /Server-Timing/);
    const body = await res.json();
    assert.deepEqual([body.ok, body.status, body.view.you], [true, 'playing', 's0']);
  });

  it('maps errors: 401, 400, 403, 405, OPTIONS 204, and 500 without details', async () => {
    const tb = table();
    const h = handlerFor(tb);
    assert.equal((await post(h, { roomId: ROOM, type: 'tick' }, null)).status, 401);
    assert.equal((await post(h, '{nope')).status, 400);
    const nm = await post(h, { roomId: ROOM, type: 'tick' }, 'x-token');
    assert.deepEqual([nm.status, (await nm.json()).error.code], [403, 'NOT_A_MEMBER']);
    assert.equal((await h(new Request('http://x/room-action', { method: 'GET' }))).status, 405);
    const pre = await h(new Request('http://x/room-action', { method: 'OPTIONS' }));
    assert.deepEqual([pre.status, pre.headers.get('Access-Control-Allow-Origin')], [204, '*']);

    const broken = createRoomActionHandler({
      service: { run: async () => { throw new Error('rpc failed: secret detail'); } },
      authenticate: async () => A,
      log: { error: () => {} },
    });
    const res = await post(broken, { roomId: ROOM, type: 'tick' });
    const text = await res.text();
    assert.equal(res.status, 500);
    assert.equal(JSON.parse(text).error.code, 'INTERNAL');
    assert.ok(!text.includes('secret detail'));
    assert.match(res.headers.get('Server-Timing'), /total;dur=/);
  });

  it('formats Server-Timing durations', () => {
    assert.equal(serverTimingHeader({ load: 1.234, engine: 0, commit: -1, total: 12 }), 'load;dur=1.2, engine;dur=0.0, commit;dur=0.0, total;dur=12.0');
  });
});
