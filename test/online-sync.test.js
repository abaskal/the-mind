'use strict';

// MIND-06 AC7/AC8 · Pure helpers of the online table (online/online-sync.js): the clock offset, the event sequencer,
// seat rotation, the public_state → UI mapping and missing-player tracking.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Sync = require('../online/online-sync.js');
const Mind = require('../engine/mind-engine.js');

function rng(seed) {
  return Mind.mulberry32(seed);
}

describe('clock offset (AC7)', () => {
  test('symmetric round trips give the exact offset', () => {
    const c = Sync.createClock();
    // Local clock 1000, server 50_000 ahead; 40 ms each way.
    assert.equal(c.sample(1000, 1080, 51_040), true);
    assert.equal(c.offset, 50_000);
    assert.equal(c.serverNow(2000), 52_000);
    assert.equal(c.toLocal(52_000), 2000);
    assert.equal(c.rtt, 80);
  });

  test('keeps the sample with the smallest round trip', () => {
    const c = Sync.createClock();
    c.sample(0, 400, 10_300); // rtt 400, offset 10_100 (asymmetric, poor)
    c.sample(1000, 1020, 11_010); // rtt 20, offset 10_000
    c.sample(2000, 2300, 12_250); // rtt 300
    assert.equal(c.rtt, 20);
    assert.equal(c.offset, 10_000);
  });

  test('stays within 50 ms of the true offset with jittery, asymmetric round trips', () => {
    const errors = [];
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed);
      const trueOffset = Math.round((r() - 0.5) * 1e9);
      const c = Sync.createClock();
      let local = 5000;
      // A full window of samples (20): one per action, plus the start-up and periodic ticks.
      for (let i = 0; i < 20; i++) {
        local += 200 + r() * 800;
        const up = 15 + r() * 250 * r(); // 15–265 ms, independently each way
        const down = 15 + r() * 250 * r();
        const serverAtArrival = local + up + trueOffset;
        c.sample(local, local + up + down, serverAtArrival);
      }
      const err = Math.abs(c.offset - trueOffset);
      errors.push(err);
      assert.ok(err <= 50, `seed ${seed}: error ${err} ms`);
    }
    errors.sort((a, b) => a - b);
    assert.ok(errors[250] < 10, `median error ${errors[250]} ms`);
  });

  test('ignores impossible samples and is not ready before the first one', () => {
    const c = Sync.createClock();
    assert.equal(c.ready, false);
    assert.equal(c.serverNow(10), null);
    assert.equal(c.sample(100, 90, 5), false);
    assert.equal(c.sample(100, 110, NaN), false);
    assert.equal(c.ready, false);
  });

  test('a better sample ages out after maxSamples', () => {
    const c = Sync.createClock({ maxSamples: 3 });
    c.sample(0, 10, 105); // rtt 10, offset 100
    for (let i = 1; i <= 3; i++) c.sample(i * 100, i * 100 + 50, i * 100 + 25 + 200); // rtt 50, offset 200
    assert.equal(c.offset, 200);
  });
});

describe('event sequencer (AC8)', () => {
  function seqr(opts) {
    const out = [];
    const timers = [];
    let gaps = 0;
    const s = Sync.createSequencer(Object.assign({
      onEvent: (e) => out.push(e.seq),
      onGap: () => gaps++,
      schedule: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1; },
      cancel: (id) => { timers[id].live = false; },
    }, opts));
    return { s, out, timers, gaps: () => gaps, fire: () => timers.filter((x) => x.live).forEach((x) => { x.live = false; x.fn(); }) };
  }
  const ev = (seq) => ({ seq, type: 't' + seq });

  test('delivers nothing before the first reset, then continues after the snapshot', () => {
    const { s, out } = seqr();
    s.push(ev(4));
    s.push(ev(5));
    assert.deepEqual(out, []);
    assert.equal(s.reset(3), 2);
    assert.deepEqual(out, [4, 5]);
  });

  test('buffers events that arrive out of order and delivers them in seq order', () => {
    const { s, out, timers } = seqr();
    s.reset(0);
    s.push(ev(3));
    s.push(ev(2));
    assert.deepEqual(out, []);
    assert.equal(timers.filter((x) => x.live).length, 1, 'a gap timer runs while 1 is missing');
    s.push(ev(1));
    assert.deepEqual(out, [1, 2, 3]);
    assert.equal(timers.filter((x) => x.live).length, 0, 'the gap closed, so its timer is cancelled');
  });

  test('ignores duplicates, delivered or still buffered', () => {
    const { s, out } = seqr();
    s.reset(0);
    s.push(ev(1));
    s.push(ev(1));
    s.push(ev(3));
    s.push(ev(3));
    s.push(ev(2));
    s.push(ev(2));
    assert.deepEqual(out, [1, 2, 3]);
    assert.equal(s.lastSeq, 3);
    assert.equal(s.push({ seq: 'x' }), 0);
  });

  test('a gap that lasts 1 s asks for a snapshot; reset() then skips what it covers', () => {
    const { s, out, timers, gaps, fire } = seqr();
    s.reset(10);
    s.push(ev(12));
    s.push(ev(13));
    assert.equal(timers[0].ms, 1000);
    fire();
    assert.equal(gaps(), 1);
    // The snapshot is at seq 12: 11 is lost, 12 is already in it, 13 still comes.
    s.reset(12);
    assert.deepEqual(out, [13]);
    assert.equal(s.lastSeq, 13);
    assert.equal(s.pending, 0);
  });

  test('a gap that closes in time never asks for a snapshot', () => {
    const { s, gaps } = seqr();
    s.reset(0);
    s.push(ev(2));
    s.push(ev(1));
    assert.equal(gaps(), 0);
  });

  test('reset never goes backwards', () => {
    const { s, out } = seqr();
    s.reset(5);
    s.push(ev(6));
    s.reset(2);
    assert.equal(s.lastSeq, 6);
    s.push(ev(4));
    assert.deepEqual(out, [6]);
  });
});

describe('seat rotation (AC8)', () => {
  const players = (ids) => ids.map((id, seat) => ({ id, seat }));

  test('you are always first (bottom), the others clockwise in seat order', () => {
    const four = players(['s0', 's1', 's2', 's3']);
    assert.deepEqual(Sync.seatOrder(four, 's0').map((p) => p.id), ['s0', 's1', 's2', 's3']);
    assert.deepEqual(Sync.seatOrder(four, 's2').map((p) => p.id), ['s2', 's3', 's0', 's1']);
    assert.deepEqual(Sync.seatOrder(four, 's3').map((p) => p.id), ['s3', 's0', 's1', 's2']);
  });

  test('works with free seats in between, ordered by room seat', () => {
    const list = [{ id: 's3', seat: 0 }, { id: 's0', seat: 1 }, { id: 's2', seat: 2 }];
    assert.deepEqual(Sync.seatOrder(list, 's2').map((p) => p.id), ['s2', 's3', 's0']);
  });

  test('every player sees themselves at the bottom and the same clockwise order', () => {
    for (const n of [2, 3, 4]) {
      const list = players(['s0', 's1', 's2', 's3'].slice(0, n));
      for (const me of list) {
        const layout = Sync.seatLayout(list, me.id);
        assert.deepEqual(layout[0], { id: me.id, pos: 'bottom' });
        const expected = { 2: ['top'], 3: ['top-left', 'top-right'], 4: ['left', 'top', 'right'] }[n];
        assert.deepEqual(layout.slice(1).map((x) => x.pos), expected);
        // Clockwise: the next seat after mine sits first after me.
        assert.equal(layout[1].id, 's' + ((Number(me.id.slice(1)) + 1) % n));
      }
    }
  });

  test('POS is the same table as the UI uses in index.html', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const m = /const POS = (\{[^;]+\});/.exec(html);
    assert.ok(m, 'index.html defines POS');
    assert.deepEqual(Function(`return ${m[1]}`)(), Sync.POS);
  });

  test('seat colors are fixed per room seat', () => {
    assert.equal(Sync.seatColor({ id: 's2' }), Sync.SEAT_COLORS[2]);
    assert.equal(Sync.seatColor({ id: 's2', seat: 0 }), Sync.seatColor({ id: 's2', seat: 1 }));
  });
});

describe('public_state → what the table UI reads (AC8)', () => {
  function engine(variant, n = 3) {
    const e = new Mind.MindEngine({
      players: Array.from({ length: n }, (_, i) => ({ id: 's' + i, name: 'P' + i, human: true })),
      variant, adapt: false, seed: 11,
    });
    e.start(100_000);
    return e;
  }
  const local = (x) => x - 90_000; // server → local

  test('maps the table, your hand and placeholders for the others', () => {
    const e = engine('classic');
    const ps = e.viewFor(null);
    const hand = e.player('s1').hand.map((c) => ({ v: c.v, pile: c.pile }));
    const m = Sync.mapState(ps, hand, 's1', { toLocal: local, syncHoldMs: Mind.TIMING.syncHold, variants: Mind.VARIANTS });
    assert.equal(m.phase, 'sync');
    assert.equal(m.level, 1);
    assert.equal(m.maxLevel, 10);
    assert.equal(m.lives, 3);
    assert.equal(m.stars, 1);
    assert.equal(m.variantId, 'classic');
    assert.equal(m.blind, false);
    assert.deepEqual(m.players.map((p) => p.id), ['s1', 's2', 's0']);
    assert.deepEqual(m.players.map((p) => p.human), [true, false, false]);
    assert.deepEqual(m.players[0].hand, hand);
    for (const p of m.players.slice(1)) {
      assert.equal(p.hand.length, e.player(p.id).hand.length);
      assert.ok(p.hand.every((c) => c.v === null && c.pile === null), 'other hands are placeholders (I2)');
      assert.equal(p.name, e.player(p.id).name);
    }
    assert.deepEqual(m.piles.map((p) => [p.id, p.dir, p.top, p.count]), [['up', 1, 0, 0]]);
    assert.equal(m.result, null);
  });

  test('server times become local times', () => {
    const e = engine('classic', 2);
    for (const p of e.players) e.placeHand(p.id, 100_500);
    let m = Sync.mapState(e.viewFor(null), [], 's0', { toLocal: local, syncHoldMs: Mind.TIMING.syncHold });
    assert.equal(m.allDownAt, local(100_500));
    e.tick(100_500 + Mind.TIMING.syncHold);
    e.proposeStar('s0', 103_000);
    m = Sync.mapState(e.viewFor(null), [], 's0', { toLocal: local });
    assert.equal(m.phase, 'starVote');
    assert.equal(m.vote.proposer, 's0');
    assert.equal(m.vote.deadline, local(103_000 + Mind.TIMING.voteTimeout));
    assert.equal(m.vote.startedAt, local(103_000));
    assert.deepEqual(m.vote.votes, { s0: true });
  });

  test('Reverse and Dual pile directions; Blind hides values until the reveal', () => {
    assert.deepEqual(Sync.mapState(engine('reverse').viewFor(null), [], 's0', {}).piles.map((p) => [p.id, p.dir, p.top]), [['down', -1, 101]]);
    assert.deepEqual(Sync.mapState(engine('dual').viewFor(null), [], 's0', {}).piles.map((p) => [p.id, p.dir]), [['up', 1], ['down', -1]]);
    const e = engine('blind', 2);
    for (const p of e.players) e.placeHand(p.id, 100_100);
    e.tick(100_100 + Mind.TIMING.syncHold);
    e.playCard('s1', null, 102_000);
    const m = Sync.mapState(e.viewFor(null), [], 's0', { variants: Mind.VARIANTS });
    assert.equal(m.blind, true);
    assert.equal(m.revealed, false);
    assert.deepEqual(m.piles[0].cards.map((c) => c.v), [null]);
    assert.equal(m.lastPlay.v, null);
    e.playCard('s0', null, 103_000);
    const after = Sync.mapState(e.viewFor(null), [], 's0', { variants: Mind.VARIANTS });
    assert.equal(after.phase, 'resolving');
    assert.equal(after.revealed, true);
    assert.ok(after.piles[0].cards.every((c) => Number.isInteger(c.v)));
  });

  test('the result of a finished game comes from public_state, or the view when it has none', () => {
    const e = engine('classic', 2);
    const ps = Object.assign(e.viewFor(null), { phase: 'gameOver' });
    const m = Sync.mapState(ps, [], 's0', {});
    assert.deepEqual(m.result, { won: false, level: 1, maxLevel: 12, stats: ps.stats, variant: 'classic' });
    const won = Sync.mapState(Object.assign({}, ps, { phase: 'victory', result: { won: true, level: 12 } }), [], 's0', {});
    assert.deepEqual(won.result, { won: true, level: 12 });
  });

  test('publicPart drops your hand from a view', () => {
    const e = engine('classic', 2);
    const view = e.viewFor('s0');
    assert.ok(Array.isArray(view.hand));
    const p = Sync.publicPart(view);
    assert.equal('hand' in p, false);
    assert.equal('you' in p, false);
    assert.deepEqual(p, (({ hand, you, ...rest }) => rest)(view));
  });
});

describe('presence and pause', () => {
  test('a seated player missing for 5 s pauses the table during sync, play and votes', () => {
    let m = Sync.trackMissing(new Map(), ['a', 'b'], new Set(['a']), 1000);
    assert.deepEqual([...m.keys()], ['b']);
    m = Sync.trackMissing(m, ['a', 'b'], new Set(['a']), 5999);
    assert.equal(Sync.shouldPause('playing', m, 5999), false);
    assert.equal(Sync.shouldPause('playing', m, 6000), true);
    assert.equal(Sync.shouldPause('sync', m, 6000), true);
    assert.equal(Sync.shouldPause('starVote', m, 6000), true);
    for (const phase of ['paused', 'levelComplete', 'resolving', 'victory', 'gameOver']) assert.equal(Sync.shouldPause(phase, m, 9000), false, phase);
    assert.deepEqual(Sync.overdue(m, 6000), ['b']);
  });

  test('coming back resets the timer', () => {
    let m = Sync.trackMissing(new Map(), ['b'], new Set(), 0);
    m = Sync.trackMissing(m, ['b'], new Set(['b']), 3000);
    assert.equal(m.size, 0);
    m = Sync.trackMissing(m, ['b'], new Set(), 4000);
    assert.equal(Sync.shouldPause('playing', m, 8999), false);
  });

  test('End game appears after 3 minutes paused, by the server clock', () => {
    assert.equal(Sync.canEndGame('paused', 1000, 1000 + 179_999), false);
    assert.equal(Sync.canEndGame('paused', 1000, 1000 + 180_000), true);
    assert.equal(Sync.canEndGame('playing', 1000, 1e9), false);
    assert.equal(Sync.canEndGame('paused', null, 1e9), false);
  });

  test('isDue', () => {
    assert.equal(Sync.isDue(100, 99), false);
    assert.equal(Sync.isDue(100, 100), true);
    assert.equal(Sync.isDue(null, 100), false);
    assert.equal(Sync.isDue(100, null), false);
  });
});
