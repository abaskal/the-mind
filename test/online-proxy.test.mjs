// MIND-06 AC8 · The online engine proxy (online/online-engine-proxy.js) against the real room-action service with its
// in-memory repository. Realtime is simulated: every commit publishes the room row, the changed hand rows (to their
// owner only) and the event rows, which a test can deliver, reorder or drop. Time is a manual clock.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createRoomActionService } from '../supabase/functions/_shared/room-action.mjs';
import { createMemoryRoomActionRepo } from '../supabase/functions/_shared/room-action-memory-repo.mjs';

const require = createRequire(import.meta.url);
const Mind = require('../engine/mind-engine.js');
const Sync = require('../online/online-sync.js');
const ProxyLib = require('../online/online-engine-proxy.js');

const ROOM = '44444444-4444-4444-8444-000000000001';
const user = (n) => `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`;
const USERS = [1, 2, 3, 4].map(user);
const OFFSET = 1_793_000_000_000; // server time − local time
const copy = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));
const iso = (ms) => new Date(ms).toISOString();
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const silent = { error() {} };

function harness({ players = 2, variant = 'classic', seed = 7 } = {}) {
  const h = { local: 10_000, subs: [], published: [], auto: true, timers: new Map(), timerId: 0, snapshots: {}, failNext: 0, hangNext: 0 };
  h.server = () => h.local + OFFSET;
  h.repo = createMemoryRoomActionRepo({ now: () => h.server() });
  h.repo.addRoom({
    id: ROOM, hostId: USERS[0], variant, status: 'lobby',
    players: USERS.slice(0, players).map((userId, seat) => ({ userId, seat, nickname: ['Ayşe', '<b>Bo</b>', 'Cem', 'Dan'][seat] })),
  });
  h.room = () => h.repo.room(ROOM);
  h.createdAt = new Map();

  // Simulated Realtime: what each commit would publish.
  const commit = h.repo.commitRoomAction.bind(h.repo);
  h.repo.commitRoomAction = async (c) => {
    const r = await commit(c);
    if (r.conflict) return r;
    const room = h.room();
    const msgs = [{ kind: 'room', row: { id: ROOM, version: room.version, status: room.status, public_state: copy(room.publicState), next_deadline_at: room.nextDeadlineAt == null ? null : iso(room.nextDeadlineAt), host_id: room.hostId } }];
    for (const hd of c.hands || []) msgs.push({ kind: 'hand', to: hd.userId, row: { room_id: ROOM, user_id: hd.userId, hand: copy(hd.hand), version: room.version } });
    (c.events || []).forEach((e, i) => {
      const seq = r.firstSeq + i;
      h.createdAt.set(seq, h.server());
      msgs.push({ kind: 'event', row: { room_id: ROOM, seq, type: e.type, payload: copy(e.payload), created_at: iso(h.server()) } });
    });
    h.published.push(...msgs);
    if (h.auto) h.deliver();
    return r;
  };
  h.deliver = (filter = () => true, order = (x) => x) => {
    const msgs = order(h.published.filter(filter));
    h.published = h.published.filter((m) => !filter(m));
    for (const m of msgs) {
      for (const s of h.subs) {
        if (m.kind === 'room') s.proxy.ingestRoomRow(copy(m.row));
        if (m.kind === 'hand' && m.to === s.userId) s.proxy.ingestHandRow(copy(m.row));
        if (m.kind === 'event') s.proxy.ingestEventRow(copy(m.row));
      }
    }
  };

  h.svc = createRoomActionService({ repo: h.repo, Mind, randomSeed: () => seed, rateLimiter: { allow: () => true } });
  h.send = (u, type, extra = {}) => h.svc.run(u, { roomId: ROOM, type, ...extra });

  // Manual timers on the local clock; the server clock moves with it.
  h.schedule = (fn, ms) => {
    const id = ++h.timerId;
    h.timers.set(id, { at: h.local + Math.max(0, ms || 0), fn });
    return id;
  };
  h.cancel = (id) => h.timers.delete(id);
  h.run = async (ms) => {
    const end = h.local + ms;
    for (;;) {
      await settle();
      const due = [...h.timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      h.timers.delete(due[0]);
      h.local = Math.max(h.local, due[1].at);
      due[1].fn();
    }
    h.local = end;
    await settle();
  };

  h.snapshot = (u) => async () => {
    h.snapshots[u] = (h.snapshots[u] || 0) + 1;
    const r = h.room();
    return {
      room: { id: ROOM, code: r.code, host_id: r.hostId, variant: r.variant, status: r.status, version: r.version, public_state: copy(r.publicState), next_deadline_at: r.nextDeadlineAt == null ? null : iso(r.nextDeadlineAt) },
      players: r.players.filter((p) => p.leftAt == null).map((p) => ({ user_id: p.userId, seat: p.seat, nickname: p.nickname })),
      hand: r.hands.has(u) ? copy(r.hands.get(u)) : null,
      events: r.events.slice(-30).reverse().map((e) => ({ seq: e.seq, type: e.type, data: copy(e.payload), at: h.createdAt.get(e.seq) })),
      pausedAt: null,
    };
  };

  // A proxy for the player in `seat`, with an instant transport (round trip 0, so the clock offset is exact).
  h.proxy = (seat, opts = {}) => {
    const u = USERS[seat];
    const calls = [];
    const transport = {
      action: async (type, input) => {
        calls.push(type);
        if (h.hangNext > 0) {
          h.hangNext--;
          return new Promise(() => {}); // a request that never comes back (a worker being replaced)
        }
        if (h.failNext > 0) {
          h.failNext--;
          const err = new Error('NETWORK');
          err.code = 'NETWORK';
          throw err;
        }
        const sentAt = h.local;
        const r = await h.send(u, type, input);
        return { status: r.status, body: copy(r.body), sentAt, receivedAt: h.local };
      },
      snapshot: h.snapshot(u),
      since: async (afterSeq) => {
        h.sinceCalls = (h.sinceCalls || 0) + 1;
        const r = h.room();
        return {
          room: { id: ROOM, host_id: r.hostId, status: r.status, version: r.version, public_state: copy(r.publicState), next_deadline_at: r.nextDeadlineAt == null ? null : iso(r.nextDeadlineAt) },
          hand: r.hands.has(u) ? copy(r.hands.get(u)) : null,
          events: r.events.filter((e) => e.seq > afterSeq).map((e) => ({ seq: e.seq, type: e.type, data: copy(e.payload), at: h.createdAt.get(e.seq) })),
        };
      },
    };
    const proxy = ProxyLib.create({
      Mind, Sync, roomId: ROOM, me: 's' + seat, userId: u, transport,
      now: () => h.local, schedule: h.schedule, cancel: h.cancel, random: () => 0.5, log: silent, ...opts,
    });
    const events = [];
    proxy.on('*', (type, data) => events.push({ type, data, version: proxy.version, phase: proxy.phase }));
    const signals = [];
    for (const s of ['refresh', 'status', 'actionDone', 'resynced', 'netError']) proxy.on(s, (d) => signals.push({ s, d }));
    h.subs.push({ proxy, userId: u });
    return { proxy, events, signals, calls, userId: u };
  };

  // Host starts; every proxy loads its snapshot and calibrates the clock; then the UI would mount and begin().
  h.start = async (list) => {
    const r = await h.send(USERS[0], 'start');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ready = list.map((x) => x.proxy.prepare());
    await h.run(500);
    await Promise.all(ready);
    for (const x of list) x.proxy.begin();
    await h.run(50);
  };
  h.handOf = (seat) => h.room().hands.get(USERS[seat]).hand;
  return h;
}

describe('online engine proxy', () => {
  it('maps the server state to the read interface of MindEngine (I2: only your own hand has values)', async () => {
    const h = harness({ players: 3 });
    const b = h.proxy(1);
    await h.start([b]);
    const p = b.proxy;
    assert.equal(p.online, true);
    assert.equal(p.phase, 'sync');
    assert.equal(p.level, 1);
    assert.equal(p.maxLevel, 10);
    assert.equal(p.lives, 3);
    assert.equal(p.stars, 1);
    assert.equal(p.variantId, 'classic');
    assert.equal(p.difficultyId, null);
    assert.equal(p.blind, false);
    assert.equal(p.version, h.room().version);
    assert.deepEqual(p.players.map((x) => [x.id, x.human]), [['s1', true], ['s2', false], ['s0', false]]);
    assert.equal(p.human.id, 's1');
    assert.deepEqual(p.human.hand, h.handOf(1));
    assert.equal(p.players[1].name, 'Cem');
    assert.equal(p.player('s0').name, 'Ayşe');
    for (const o of p.players.filter((x) => !x.human)) {
      assert.equal(o.hand.length, 1);
      assert.deepEqual(o.hand, [{ v: null, pile: null }]);
    }
    assert.deepEqual(p.piles.map((x) => [x.id, x.top, x.cards.length]), [['up', 0, 0]]);
    // The engine's own helpers (I4).
    assert.equal(p.urgent(p.human, 'up'), p.human.hand[0]);
    assert.equal(p.urgent(p.players[1], 'up'), null);
    assert.equal(p.rewardFor(2), 'star');
    assert.equal(p.rewardFor(3), 'life');
    assert.equal(p.isHost, false);
    const dbg = p.debug();
    assert.equal(dbg.version, p.version);
    assert.equal(JSON.stringify(dbg).includes('"hand"'), false, 'the debug hook never carries a hand');
    for (const v of [...h.handOf(0), ...h.handOf(2)].map((c) => c.v)) {
      assert.equal(JSON.stringify(p.players).includes(`"v":${v}`), false, `another player's card ${v} is not exposed`);
    }
    // Arriving at the opening sync replays the level's events, so the deal animation runs.
    assert.deepEqual(b.events.map((e) => e.type), ['levelStart', 'syncStart']);
  });

  it('plays a level for everybody: same versions, events in order, the deadline ticked by the clients', async () => {
    const h = harness({ players: 2, seed: 3 });
    const a = h.proxy(0);
    const b = h.proxy(1);
    await h.start([a, b]);
    assert.equal(a.proxy.placeHand(), true);
    assert.equal(a.proxy.placeHand(), false, 'one request at a time per action');
    await h.run(50);
    assert.equal(b.proxy.placeHand(), true);
    await h.run(50);
    assert.equal(a.proxy.allDownAt, h.room().publicState.deadlines.syncHold - Mind.TIMING.syncHold - OFFSET);
    // Nothing happens until the server clock passes the sync hold; then a client ticks after 0–150 ms.
    await h.run(Mind.TIMING.syncHold - 100);
    for (const x of [a, b]) x.proxy.tick(h.local);
    assert.equal(h.room().publicState.phase, 'sync');
    await h.run(150);
    for (const x of [a, b]) x.proxy.tick(h.local);
    await h.run(200);
    assert.equal(h.room().publicState.phase, 'playing');
    assert.ok(a.calls.includes('tick') && b.calls.includes('tick'));
    // Lowest card first.
    const order = [0, 1].sort((x, y) => h.handOf(x)[0].v - h.handOf(y)[0].v);
    for (const seat of order) {
      assert.equal([a, b][seat].proxy.humanPlay(null), true);
      await h.run(100);
    }
    for (const x of [a, b]) {
      assert.equal(x.proxy.version, h.room().version);
      assert.equal(x.proxy.phase, 'levelComplete');
      assert.equal(x.proxy.human.hand.length, 0);
      assert.deepEqual(x.proxy.piles[0].cards.map((c) => c.v), h.room().publicState.piles[0].cards.map((c) => c.v));
      const types = x.events.map((e) => e.type);
      assert.equal(types.filter((t) => t === 'play').length, 2);
      assert.equal(types.at(-1), 'levelComplete');
      // Each event is emitted once, after the state that contains it.
      const seqTypes = h.room().events.map((e) => e.type);
      assert.deepEqual(types, seqTypes, 'every event, once, in seq order');
    }
    assert.equal(a.proxy.piles[0].top, h.room().publicState.piles[0].top);
    assert.equal(a.proxy.nextLevel(), true);
    await h.run(100);
    assert.equal(b.proxy.level, 2);
    assert.equal(b.proxy.human.hand.length, 2);
    assert.equal(b.events.at(-2).type, 'levelStart');
    // The level start is emitted with the new hand already in place.
    assert.equal(b.events.at(-2).phase, 'sync');
  });

  it('buffers events that arrive out of order and ignores duplicates from the reply and Realtime', async () => {
    const h = harness({ players: 2 });
    const a = h.proxy(0);
    const b = h.proxy(1);
    await h.start([a, b]);
    h.auto = false;
    a.proxy.placeHand();
    await h.run(50);
    b.proxy.placeHand();
    await h.run(50);
    // b's reply carried its own events (seq 4–5), which wait for a's handDown (seq 3).
    assert.deepEqual(b.events.map((e) => e.type), ['levelStart', 'syncStart']);
    assert.equal(b.proxy.seq.pending, 2);
    // Realtime then delivers everything, events reversed: 4–5 again (duplicates) and 3.
    h.deliver((m) => m.kind === 'event', (list) => list.slice().reverse());
    h.deliver();
    await h.run(50);
    const all = h.room().events.map((e) => e.type);
    assert.deepEqual(all.slice(-3), ['handDown', 'handDown', 'allHandsDown']);
    for (const x of [a, b]) assert.deepEqual(x.events.map((e) => e.type), all, 'every event once, in seq order');
    assert.equal(a.proxy.version, h.room().version);
    assert.equal(b.proxy.version, h.room().version);
  });

  it('a gap longer than 1 s fetches a snapshot and carries on from it', async () => {
    const h = harness({ players: 2 });
    const a = h.proxy(0);
    const b = h.proxy(1);
    await h.start([a, b]);
    h.auto = false;
    await h.send(USERS[1], 'handDown'); // b acts on another device: a only learns from Realtime
    const lost = h.published.filter((m) => m.kind === 'event').map((m) => m.row.seq);
    h.published = []; // lost
    await h.send(USERS[0], 'pause');
    h.deliver((m) => m.kind === 'event');
    await h.run(500);
    assert.equal(a.proxy.seq.pending, 1, 'the paused event waits for the lost one');
    const snapshots = h.snapshots[a.userId];
    await h.run(700);
    assert.equal(h.snapshots[a.userId], snapshots + 1, 'one snapshot after 1 s');
    assert.equal(a.proxy.version, h.room().version);
    assert.equal(a.proxy.phase, 'paused');
    assert.ok(a.proxy.seq.lastSeq >= lost[0]);
    assert.ok(a.signals.some((x) => x.s === 'refresh'));
    assert.ok(a.signals.some((x) => x.s === 'resynced'));
  });

  it('a state change that no event explains asks the UI to redraw', async () => {
    const h = harness({ players: 2 });
    const a = h.proxy(0);
    await h.start([a]);
    h.auto = false;
    await h.send(USERS[1], 'handDown');
    h.deliver((m) => m.kind !== 'event');
    await h.run(50);
    assert.equal(a.proxy.player('s1').handDown, true);
    assert.equal(a.signals.filter((x) => x.s === 'refresh').length >= 1, true);
  });

  it('INVALID_MOVE resyncs quietly from the reply; nothing is thrown', async () => {
    const h = harness({ players: 2 });
    const a = h.proxy(0);
    await h.start([a]);
    // Not possible during sync: the proxy refuses locally…
    assert.equal(a.proxy.humanPlay(null), false);
    // …and when the server refuses, its reply carries the state.
    const r = await a.proxy.send('play', {});
    assert.deepEqual(r, { ok: false, code: 'INVALID_MOVE' });
    await h.run(50);
    const done = a.signals.filter((x) => x.s === 'actionDone').at(-1).d;
    assert.deepEqual(done, { type: 'play', ok: false, code: 'INVALID_MOVE' });
    assert.ok(a.signals.some((x) => x.s === 'refresh'));
    assert.equal(a.proxy.version, h.room().version);
  });

  it('ticks a deadline on its own timer, with no animation frames (a background tab)', async () => {
    const h = harness({ players: 2 });
    const a = h.proxy(0);
    const b = h.proxy(1);
    await h.start([a, b]);
    a.proxy.placeHand();
    b.proxy.placeHand();
    // No proxy.tick(...) calls at all from here: only the proxies' own timers run.
    await h.run(Mind.TIMING.syncHold + 200);
    assert.equal(h.room().publicState.phase, 'playing');
    for (const x of [a, b]) assert.equal(x.proxy.phase, 'playing');
  });

  it('a lost tick is retried once after 1 s', async () => {
    // Only one client here, so its retry is the only thing that can move the table on.
    const h = harness({ players: 2 });
    const a = h.proxy(0);
    await h.start([a]);
    a.proxy.placeHand();
    await h.run(50);
    await h.send(USERS[1], 'handDown');
    const ticks = () => a.calls.filter((c) => c === 'tick').length;
    const before = ticks();
    h.failNext = 1;
    await h.run(Mind.TIMING.syncHold + 200);
    assert.equal(ticks(), before + 1);
    assert.equal(h.room().publicState.phase, 'sync', 'the first tick was lost');
    await h.run(1000);
    assert.equal(ticks(), before + 2);
    assert.equal(h.room().publicState.phase, 'playing');
    assert.equal(a.proxy.phase, 'playing');
  });

  it('when a tick and its retry both fail, a new round starts 2.5 s later', async () => {
    const h = harness({ players: 2 });
    const a = h.proxy(0);
    await h.start([a]);
    a.proxy.placeHand();
    await h.run(50);
    await h.send(USERS[1], 'handDown');
    h.failNext = 2;
    await h.run(Mind.TIMING.syncHold + 1300);
    assert.equal(h.room().publicState.phase, 'sync', 'tick and retry were lost');
    await h.run(1500);
    assert.equal(h.room().publicState.phase, 'playing');
    assert.equal(a.proxy.phase, 'playing');
  });

  it('a hanging tick does not hold back the retry (ticks are idempotent)', async () => {
    const h = harness({ players: 2 });
    const a = h.proxy(0);
    await h.start([a]);
    a.proxy.placeHand();
    await h.run(50);
    await h.send(USERS[1], 'handDown');
    h.hangNext = 1;
    await h.run(Mind.TIMING.syncHold + 200);
    assert.equal(h.room().publicState.phase, 'sync');
    assert.equal(a.proxy.inflight('tick'), true);
    await h.run(1000);
    assert.equal(h.room().publicState.phase, 'playing');
    assert.equal(a.proxy.phase, 'playing');
    // A user action is never sent twice at once.
    h.hangNext = 1;
    assert.equal(a.proxy.proposeStar(), true);
    assert.equal(a.proxy.proposeStar(), false);
  });

  it('vote countdown and pause time come from the server clock', async () => {
    const h = harness({ players: 2 });
    const a = h.proxy(0);
    const b = h.proxy(1);
    await h.start([a, b]);
    a.proxy.placeHand();
    b.proxy.placeHand();
    await h.run(Mind.TIMING.syncHold + 10);
    a.proxy.tick(h.local);
    await h.run(300);
    assert.equal(a.proxy.proposeStar(), true);
    await h.run(50);
    const deadline = h.room().publicState.vote.deadline;
    for (const x of [a, b]) {
      assert.equal(x.proxy.phase, 'starVote');
      assert.equal(x.proxy.vote.deadline, deadline - OFFSET, 'server deadline in local time');
    }
    assert.equal(a.proxy.voteStar(true), false, 'the proposer already voted');
    assert.equal(b.proxy.voteStar(false), true);
    await h.run(50);
    assert.equal(a.proxy.phase, 'playing');
    assert.ok(a.events.some((e) => e.type === 'starRejected'));
    assert.equal(b.proxy.pause(), true);
    await h.run(50);
    assert.equal(a.proxy.phase, 'paused');
    assert.equal(a.proxy.pausedAt, h.server() - 50);
    assert.equal(a.proxy.canEndGame(h.local), false);
    await h.run(Sync.END_GAME_AFTER_PAUSE_MS);
    assert.equal(a.proxy.canEndGame(h.local), true);
  });

  it('your own Blind card shows its value to you only', async () => {
    const h = harness({ players: 2, variant: 'blind' });
    const a = h.proxy(0);
    const b = h.proxy(1);
    await h.start([a, b]);
    a.proxy.placeHand();
    b.proxy.placeHand();
    await h.run(Mind.TIMING.syncHold + 10);
    a.proxy.tick(h.local);
    await h.run(300);
    const mine = h.handOf(0)[0].v;
    assert.equal(a.proxy.humanPlay(null), true);
    await h.run(100);
    const aPlay = a.events.find((e) => e.type === 'play');
    const bPlay = b.events.find((e) => e.type === 'play');
    assert.equal(aPlay.data.card.v, mine);
    assert.equal(bPlay.data.card.v, null);
    assert.deepEqual(b.proxy.piles[0].cards.map((c) => c.v), [null]);
  });

  it('a rematch sends the table back to the lobby', async () => {
    const h = harness({ players: 2 });
    const a = h.proxy(0);
    await h.start([a]);
    h.room().status = 'finished';
    // Stored state of a finished game (test setup), then the host asks for a rematch.
    assert.equal(a.proxy.isHost, true);
    a.proxy.status = 'finished';
    assert.equal(a.proxy.rematch(), true);
    await h.run(50);
    assert.equal(a.proxy.status, 'lobby');
    assert.ok(a.signals.some((x) => x.s === 'status' && x.d.status === 'lobby'));
    assert.ok(a.events.some((e) => e.type === 'rematch'));
  });

  it('the version broadcast catches up at once, with the events in order, before Postgres Changes arrive', async () => {
    const h = harness({ players: 2 });
    const a = h.proxy(0);
    const b = h.proxy(1);
    await h.start([a, b]);
    h.auto = false; // Postgres Changes are slow: nothing arrives by them until deliver() below
    b.proxy.placeHand();
    await h.run(50);
    assert.equal(a.proxy.version, h.room().version - 1);
    a.proxy.noteVersion(h.room().version); // the database's Broadcast `version`
    await h.run(50);
    assert.equal(a.proxy.version, h.room().version);
    assert.equal(a.proxy.player('s1').handDown, true);
    assert.equal(a.events.at(-1).type, 'handDown');
    // Realtime's late copies are duplicates.
    const n = a.events.length;
    h.deliver();
    await h.run(50);
    assert.equal(a.events.length, n);
  });

  it('a catch-up read that fails or is behind is tried again until the announced version is there', async () => {
    const h = harness({ players: 2 });
    const a = h.proxy(0);
    const b = h.proxy(1);
    await h.start([a, b]);
    h.auto = false;
    // a's catch-up reads: the first fails, the second is still behind (a busy server), the third has it.
    const since = a.proxy.transport.since;
    const stale = await since(a.proxy.seq.lastSeq);
    let reads = 0;
    a.proxy.transport.since = async (afterSeq) => {
      reads++;
      if (reads === 1) throw Object.assign(new Error('NETWORK'), { code: 'NETWORK' });
      if (reads === 2) return stale;
      return since(afterSeq);
    };
    b.proxy.placeHand();
    await h.run(50);
    a.proxy.noteVersion(h.room().version);
    await h.run(600);
    assert.equal(reads, 3);
    assert.equal(a.proxy.version, h.room().version);
    assert.equal(a.events.at(-1).type, 'handDown');
  });

  it('a false version announcement costs a few reads, then stops', async () => {
    const h = harness({ players: 2 });
    const a = h.proxy(0);
    await h.start([a]);
    h.sinceCalls = 0;
    a.proxy.noteVersion(1e9);
    await h.run(5000);
    assert.ok(h.sinceCalls <= 5, `${h.sinceCalls} reads`);
    assert.equal(a.proxy.version, h.room().version, 'the real version stays');
  });

  it('a burst of version broadcasts costs at most one fetch per 250 ms', async () => {
    const h = harness({ players: 2 });
    const a = h.proxy(0);
    await h.start([a]);
    h.sinceCalls = 0;
    for (let i = 0; i < 20; i++) {
      a.proxy.noteVersion(1e9);
      await h.run(10);
    }
    assert.ok(h.sinceCalls <= 2, `${h.sinceCalls} fetches in 200 ms`);
    assert.equal(a.proxy.version, h.room().version, 'the real version stays');
  });

  it('a status that only a later message of the same version carries is not lost', async () => {
    const h = harness({ players: 2 });
    const a = h.proxy(0);
    await h.start([a]);
    const v = a.proxy.version + 1;
    const view = Object.assign(copy(h.room().publicState), { phase: 'gameOver', hand: copy(h.handOf(0)) });
    // First an INVALID_MOVE reply (state, no status), then the Realtime row of the same version (with status).
    a.proxy.ingestResponse({ status: 409, body: { error: { code: 'INVALID_MOVE' }, view, version: v, serverNow: h.server() }, sentAt: h.local, receivedAt: h.local });
    await h.run(50);
    assert.equal(a.proxy.version, v);
    assert.equal(a.proxy.status, 'playing');
    a.proxy.ingestRoomRow({ id: ROOM, version: v, status: 'finished', public_state: Object.assign(copy(view), { hand: undefined }), next_deadline_at: null, host_id: USERS[0] });
    assert.equal(a.proxy.status, 'finished');
    assert.ok(a.signals.some((x) => x.s === 'status' && x.d.status === 'finished'));
  });

  it('a room row without its public_state does not hide the state of that version from the snapshot', async () => {
    const h = harness({ players: 2 });
    const a = h.proxy(0);
    await h.start([a]);
    h.auto = false;
    await h.send(USERS[1], 'handDown');
    const row = h.published.find((m) => m.kind === 'room').row;
    h.published = [];
    a.proxy.ingestRoomRow(Object.assign({}, row, { public_state: undefined }));
    await h.run(100);
    assert.equal(a.proxy.version, h.room().version, 'the snapshot brought the version');
    assert.equal(a.proxy.player('s1').handDown, true, 'and its state');
  });

  it('dispose stops every timer and listener', async () => {
    const h = harness({ players: 2 });
    const a = h.proxy(0);
    await h.start([a]);
    a.proxy.dispose();
    a.proxy.ingestEventRow({ room_id: ROOM, seq: 99, type: 'x', payload: {} });
    assert.equal(h.timers.size, 0);
    assert.equal(a.proxy.placeHand(), false);
    await a.proxy.send('handDown');
    await h.run(50);
    assert.equal(a.calls.filter((c) => c === 'handDown').length, 0);
  });
});
