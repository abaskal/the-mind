'use strict';

// MIND-01 characterization tests: they lock in today's offline rules before MIND-02 refactors the engine.
// They only use the API the offline UI already uses (constructor options, start/tick, placeHand, humanPlay,
// proposeStar, voteStar, callRefocus, pause/resume, nextLevel, events and public state).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  MindEngine, mulberry32, longestRun, LEVELS_BY_PLAYERS, LEVEL_REWARDS, MAX_LIVES, MAX_STARS, VARIANTS, DIFFICULTY, TIMING,
} = require('../engine/mind-engine.js');

const BOT_IDS = ['b1', 'b2', 'b3'];
// Every bot puts its hand down within 450 + 1500 ms of a sync starting.
const BOTS_DOWN = 2000;

function makeGame({ bots = 2, human = true, variant, difficulty, seed = 1, sigma } = {}) {
  const players = human ? [{ id: 'you', human: true }] : [];
  for (const id of BOT_IDS.slice(0, bots)) players.push(sigma == null ? { id } : { id, sigma });
  const e = new MindEngine({ players, variant, difficulty, rng: mulberry32(seed) });
  const events = [];
  e.on('*', (type, data) => events.push({ type, data }));
  return { e, events };
}

const eventsOf = (events, type) => events.filter((x) => x.type === type).map((x) => x.data);
const values = (player) => player.hand.map((c) => c.v);

// Replaces the dealt hands while the table is still in sync, so bots plan their plays with these cards.
// A number means a card on the first pile; { v, pile } picks the pile (Dual).
function setHands(e, hands) {
  assert.equal(e.phase, 'sync');
  for (const p of e.players) {
    p.hand = (hands[p.id] || []).map((c) => (typeof c === 'number' ? { v: c, pile: e.piles[0].id } : { v: c.v, pile: c.pile }));
  }
}

// Puts the human hand down at t, lets the bots follow, waits out the sync hold and returns the time play started.
function startPlay(e, t) {
  assert.equal(e.phase, 'sync');
  for (const p of e.players) if (p.human) e.placeHand(p.id, t);
  e.tick(t + BOTS_DOWN);
  const playAt = t + BOTS_DOWN + TIMING.syncHold;
  e.tick(playAt);
  assert.equal(e.phase, 'playing');
  return playAt;
}

function startedGame(opts, hands) {
  const g = makeGame(opts);
  g.e.start(0);
  if (hands) setHands(g.e, hands);
  g.t = startPlay(g.e, 0);
  return g;
}

// Ticks every 100 ms from t while the table is in play; returns the last tick time.
function tickWhilePlaying(e, t) {
  while (e.phase === 'playing' && t < 600000) e.tick((t += 100));
  return t;
}

// With sigma 0 a bot holding card v (gap v from an empty up pile) plays TIMING.base + v × normal tempo after its anchor.
// Literals on purpose, so a timing change fails the tests instead of moving with them.
const botDelay = (v) => 450 + v * 300;

// Clears the current level with a single card held by "you"; returns the time the level ended.
function clearLevel(e, t) {
  setHands(e, { you: [50] });
  const at = startPlay(e, t);
  assert.equal(e.humanPlay(null, at), true);
  return at;
}

describe('rng', () => {
  it('mulberry32 is deterministic and returns values in [0, 1)', () => {
    const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
    const seqA = Array.from({ length: 50 }, a);
    assert.deepEqual(Array.from({ length: 50 }, b), seqA);
    assert.notDeepEqual(Array.from({ length: 50 }, c), seqA);
    assert.ok(seqA.every((x) => x >= 0 && x < 1));
  });

  it('the same seed deals the same hands', () => {
    const deal = (seed) => {
      const { e } = makeGame({ bots: 3, seed });
      e.start(0);
      return e.players.map(values);
    };
    assert.deepEqual(deal(7), deal(7));
    assert.notDeepEqual(deal(7), deal(8));
  });
});

describe('setup', () => {
  it('levels per player count: 2 → 12, 3 → 10, 4 → 8', () => {
    assert.deepEqual(LEVELS_BY_PLAYERS, { 2: 12, 3: 10, 4: 8 });
    for (const [bots, levels] of [[1, 12], [2, 10], [3, 8]]) {
      assert.equal(makeGame({ bots }).e.maxLevel, levels);
    }
  });

  it('Blind mode plays half the levels, rounded up', () => {
    for (const [bots, levels] of [[1, 6], [2, 5], [3, 4]]) {
      assert.equal(makeGame({ bots, variant: 'blind' }).e.maxLevel, levels);
    }
  });

  it('only 2–4 players can play', () => {
    assert.throws(() => makeGame({ bots: 0 }), /2–4 players/);
    const five = [{ id: 'you', human: true }, { id: 'b1' }, { id: 'b2' }, { id: 'b3' }, { id: 'b4' }];
    assert.throws(() => new MindEngine({ players: five }), /2–4 players/);
  });

  it('starting lives equal the player count and stars start at 1', () => {
    for (const bots of [1, 2, 3]) {
      const { e } = makeGame({ bots });
      assert.equal(e.lives, bots + 1);
      assert.equal(e.stars, 1);
      assert.equal(e.phase, 'idle');
      assert.equal(e.level, 0);
    }
    assert.equal(MAX_LIVES, 5);
    assert.equal(MAX_STARS, 3);
  });

  it('unknown variant and difficulty fall back to classic and normal', () => {
    const { e } = makeGame({ variant: 'nope', difficulty: 'nope' });
    assert.equal(e.variantId, 'classic');
    assert.equal(e.difficultyId, 'normal');
    assert.deepEqual(Object.keys(VARIANTS), ['classic', 'reverse', 'blind', 'dual']);
  });

  it('timing and difficulty tables are unchanged', () => {
    assert.deepEqual(TIMING, {
      base: 450, minDelay: 260, syncHold: 1400, mistakePause: 2800, starPause: 2300,
      revealStep: 380, voteTimeout: 12000, perfectSyncWindow: 1000,
    });
    assert.deepEqual(DIFFICULTY, {
      easy: { tempo: 360, noise: 0.55 },
      normal: { tempo: 300, noise: 0.85 },
      hard: { tempo: 240, noise: 1.15 },
    });
  });
});

describe('dealing', () => {
  it('every dealt card is unique and each hand holds as many cards as the level number', () => {
    const { e, events } = makeGame({ bots: 3, seed: 3 });
    e.start(0);
    let t = 0;
    for (let level = 1; level <= 8; level++) {
      assert.equal(e.level, level);
      const all = e.players.flatMap(values);
      for (const p of e.players) assert.equal(p.hand.length, level);
      assert.equal(new Set(all).size, all.length);
      assert.ok(all.every((v) => Number.isInteger(v) && v >= 1 && v <= 100));
      assert.ok(e.players.every((p) => p.hand.every((c) => c.pile === 'up')));
      t = clearLevel(e, t);
      if (level < 8) assert.equal(e.nextLevel(t + 100), true);
      t += 100;
    }
    assert.deepEqual(eventsOf(events, 'levelStart').map((d) => d.level), [1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('hands-down sync', () => {
  it('play only starts after every hand is down and TIMING.syncHold has passed', () => {
    const { e, events } = makeGame();
    e.start(0);
    assert.equal(e.phase, 'sync');
    assert.deepEqual(eventsOf(events, 'syncStart'), [{ reason: 'level' }]);
    assert.equal(e.humanPlay(null, 100), false);

    e.tick(10000);
    assert.ok(e.players.filter((p) => !p.human).every((p) => p.handDown));
    assert.equal(e.allDownAt, null);
    assert.equal(e.phase, 'sync');

    assert.equal(e.placeHand('you', 10000), true);
    assert.equal(e.placeHand('you', 10000), false);
    e.tick(10000);
    assert.equal(eventsOf(events, 'allHandsDown').length, 1);
    e.tick(10000 + TIMING.syncHold - 1);
    assert.equal(e.phase, 'sync');
    e.tick(10000 + TIMING.syncHold);
    assert.equal(e.phase, 'playing');
    assert.deepEqual(eventsOf(events, 'playing'), [{ reason: 'level' }]);
    assert.equal(e.placeHand('you', 20000), false);
  });

  it('a bot plays at base + gap × tempo × pace after play starts (no noise with sigma 0)', () => {
    const { e, events, t } = startedGame({ bots: 1, sigma: 0 }, { you: [50], b1: [10] });
    const at = t + botDelay(10);
    e.tick(at - 1);
    assert.equal(eventsOf(events, 'play').length, 0);
    e.tick(at);
    assert.deepEqual(eventsOf(events, 'play').map((d) => [d.playerId, d.card.v]), [['b1', 10]]);
    assert.equal(e.pile('up').top, 10);
  });
});

describe('plays and mistakes', () => {
  it('cards played in order keep every life and complete the level', () => {
    const { e, events, t } = startedGame({ bots: 1 }, { you: [10, 50] });
    assert.equal(e.humanPlay(null, t), true);
    assert.equal(e.humanPlay(null, t + 2000), true);
    assert.deepEqual(e.pile('up').cards.map((c) => c.v), [10, 50]);
    assert.equal(e.lives, 2);
    assert.equal(e.phase, 'levelComplete');
    assert.deepEqual(eventsOf(events, 'levelComplete'), [{ level: 1, reward: null, applied: false, flawless: true, lives: 2, stars: 1 }]);
  });

  it('a mistake discards every lower card held by any player and costs 1 life', () => {
    const { e, events, t } = startedGame({ bots: 2 }, { you: [40], b1: [5, 20, 60], b2: [15] });
    assert.equal(e.humanPlay(null, t), true);
    assert.equal(e.lives, 2);
    assert.deepEqual(e.players.map(values), [[], [60], []]);
    assert.deepEqual(eventsOf(events, 'mistake'), [{
      playerId: 'you',
      card: { v: 40, pile: 'up' },
      offenders: [{ playerId: 'b1', cards: [5, 20] }, { playerId: 'b2', cards: [15] }],
      lives: 2,
    }]);
    assert.deepEqual(e.discard.map((d) => [d.v, d.by, d.reason]), [[5, 'b1', 'mistake'], [20, 'b1', 'mistake'], [15, 'b2', 'mistake']]);
    assert.equal(e.stats.mistakes, 1);
    assert.equal(e.stats.livesLost, 1);

    assert.equal(e.phase, 'resolving');
    e.tick(t + TIMING.mistakePause - 1);
    assert.equal(e.phase, 'resolving');
    e.tick(t + TIMING.mistakePause);
    assert.equal(e.phase, 'sync');
    assert.deepEqual(eventsOf(events, 'syncStart').at(-1), { reason: 'mistake' });
  });

  it('a mistake that empties every hand still ends the level', () => {
    const { e, events, t } = startedGame({ bots: 1 }, { you: [40], b1: [5] });
    e.humanPlay(null, t);
    e.tick(t + TIMING.mistakePause);
    assert.equal(e.phase, 'levelComplete');
    assert.equal(eventsOf(events, 'levelComplete')[0].flawless, false);
  });
});

describe('end of game', () => {
  it('clearing the last level is a victory', () => {
    const { e, events } = makeGame({ bots: 3 });
    e.start(0);
    let t = 0;
    while (e.phase !== 'victory') {
      t = clearLevel(e, t) + 100;
      if (e.phase === 'levelComplete') e.nextLevel(t);
    }
    assert.equal(e.level, 8);
    assert.equal(e.stats.levelsCleared, 8);
    assert.equal(e.stats.endedAt, t - 100);
    assert.deepEqual(eventsOf(events, 'victory'), [{ level: 8, flawless: true }]);
    assert.equal(eventsOf(events, 'levelComplete').length, 7);
  });

  it('losing the last life is game over', () => {
    const { e, events, t } = startedGame({ bots: 1 }, { you: [40], b1: [5, 60] });
    e.humanPlay(null, t);
    assert.equal(e.lives, 1);
    const t2 = t + TIMING.mistakePause;
    e.tick(t2);
    setHands(e, { you: [70], b1: [60, 90] });
    const t3 = startPlay(e, t2);
    e.humanPlay(null, t3);
    assert.equal(e.lives, 0);
    e.tick(t3 + TIMING.mistakePause - 1);
    assert.equal(e.phase, 'resolving');
    e.tick(t3 + TIMING.mistakePause);
    assert.equal(e.phase, 'gameOver');
    assert.equal(e.stats.endedAt, t3 + TIMING.mistakePause);
    assert.deepEqual(eventsOf(events, 'gameOver'), [{ level: 1 }]);
  });
});

describe('level rewards', () => {
  it('star after levels 2, 5, 8 and life after 3, 6, 9, capped at 5 lives and 3 stars', () => {
    assert.deepEqual(LEVEL_REWARDS, { 2: 'star', 3: 'life', 5: 'star', 6: 'life', 8: 'star', 9: 'life' });
    const { e, events } = makeGame({ bots: 2 });
    e.start(0);
    let t = 0;
    while (e.phase !== 'victory') {
      t = clearLevel(e, t) + 100;
      if (e.phase === 'levelComplete') e.nextLevel(t);
    }
    const summary = eventsOf(events, 'levelComplete').map((d) => [d.level, d.reward, d.applied, d.lives, d.stars]);
    assert.deepEqual(summary, [
      [1, null, false, 3, 1],
      [2, 'star', true, 3, 2],
      [3, 'life', true, 4, 2],
      [4, null, false, 4, 2],
      [5, 'star', true, 4, 3],
      [6, 'life', true, 5, 3],
      [7, null, false, 5, 3],
      [8, 'star', false, 5, 3],
      [9, 'life', false, 5, 3],
    ]);
    assert.equal(e.level, 10);
  });

  it('nextLevel only works once the level is complete and deals level + 1 cards', () => {
    const { e, t } = startedGame({ bots: 1 }, { you: [50] });
    assert.equal(e.nextLevel(t), false);
    e.humanPlay(null, t);
    assert.equal(e.nextLevel(t + 100), true);
    assert.equal(e.level, 2);
    assert.equal(e.phase, 'sync');
    assert.ok(e.players.every((p) => p.hand.length === 2));
  });
});

describe('star vote', () => {
  it('proposing a star opens a vote with the proposer counted as yes', () => {
    const { e, events, t } = startedGame({ bots: 2 }, { you: [10], b1: [50], b2: [80] });
    assert.equal(e.proposeStar('you', t), true);
    assert.equal(e.phase, 'starVote');
    assert.equal(e.vote.proposer, 'you');
    assert.equal(e.vote.votes.you, true);
    assert.equal(e.vote.deadline, t + TIMING.voteTimeout);
    assert.deepEqual(eventsOf(events, 'starProposed'), [{ proposer: 'you', needsHuman: false }]);
    assert.equal(e.proposeStar('you', t), false);
  });

  it('the star is used when every player accepts', () => {
    const { e, events, t } = startedGame({ bots: 1 }, { you: [10, 70], b1: [20, 85] });
    assert.equal(e.voteStar(true, t), false);
    assert.equal(e.proposeStar('b1', t), true);
    assert.deepEqual(eventsOf(events, 'starProposed'), [{ proposer: 'b1', needsHuman: true }]);
    assert.equal(e.voteStar(true, t + 500), true);
    assert.equal(e.voteStar(true, t + 500), false);
    assert.equal(e.stars, 0);
    assert.equal(e.stats.starsUsed, 1);
    assert.equal(e.phase, 'resolving');
    e.tick(t + 500 + TIMING.starPause);
    assert.equal(e.phase, 'playing');
    assert.deepEqual(eventsOf(events, 'playing').at(-1), { reason: 'resume' });
    assert.equal(e.proposeStar('you', t + 3000), false);
  });

  it('one "no" rejects the star', () => {
    const { e, events, t } = startedGame({ bots: 1 }, { you: [10], b1: [50] });
    e.proposeStar('b1', t);
    assert.equal(e.voteStar(false, t + 500), true);
    assert.deepEqual(eventsOf(events, 'starRejected'), [{ by: 'you' }]);
    assert.equal(e.phase, 'playing');
    assert.equal(e.stars, 1);
    assert.equal(e.vote, null);
  });

  it('a vote that times out counts as "no"', () => {
    const { e, events, t } = startedGame({ bots: 1 }, { you: [10], b1: [50] });
    e.proposeStar('b1', t);
    e.tick(t + TIMING.voteTimeout - 1);
    assert.equal(e.phase, 'starVote');
    e.tick(t + TIMING.voteTimeout);
    assert.deepEqual(eventsOf(events, 'starVote'), [{ playerId: 'you', agree: false, timeout: true }]);
    assert.deepEqual(eventsOf(events, 'starRejected'), [{ by: 'you' }]);
    assert.equal(e.phase, 'playing');
    assert.equal(e.stars, 1);
  });

  it('a star discards each player\'s lowest card', () => {
    const { e, events, t } = startedGame({ bots: 1 }, { you: [10, 70], b1: [20, 85] });
    e.proposeStar('b1', t);
    e.voteStar(true, t);
    assert.deepEqual(e.players.map(values), [[70], [85]]);
    assert.deepEqual(eventsOf(events, 'star'), [{
      discards: [{ playerId: 'you', v: 10, pile: 'up' }, { playerId: 'b1', v: 20, pile: 'up' }],
      stars: 0,
    }]);
    assert.deepEqual(e.discard.map((d) => [d.v, d.reason]), [[10, 'star'], [20, 'star']]);
    assert.equal(e.pile('up').ref, 10);
  });

  it('in Dual mode a star discards the most urgent card per pile (lowest up, highest down)', () => {
    const { e, t } = startedGame({ bots: 1, variant: 'dual' }, {
      you: [{ v: 30, pile: 'up' }, { v: 60, pile: 'up' }, { v: 80, pile: 'down' }, { v: 55, pile: 'down' }],
      b1: [{ v: 40, pile: 'up' }, { v: 90, pile: 'down' }],
    });
    e.proposeStar('b1', t);
    e.voteStar(true, t);
    assert.deepEqual(e.player('you').hand, [{ v: 60, pile: 'up' }, { v: 55, pile: 'down' }]);
    assert.deepEqual(e.player('b1').hand, []);
    assert.deepEqual(e.discard.map((d) => [d.v, d.pile, d.by]), [[30, 'up', 'you'], [40, 'up', 'b1'], [80, 'down', 'you'], [90, 'down', 'b1']]);
    assert.equal(e.pile('up').ref, 30);
    assert.equal(e.pile('down').ref, 90);
  });

  it('a star that empties every hand ends the level, which is then not flawless', () => {
    const { e, events, t } = startedGame({ bots: 1 }, { you: [10], b1: [20] });
    e.proposeStar('b1', t);
    e.voteStar(true, t);
    e.tick(t + TIMING.starPause);
    assert.equal(e.phase, 'levelComplete');
    assert.equal(eventsOf(events, 'levelComplete')[0].flawless, false);
  });

  it('bots accept about 93% of stars, but only 30% when their card is within 2 of the pile (seeded counts)', () => {
    const agreements = (botCard, seed) => {
      const rng = mulberry32(seed);
      let yes = 0;
      for (let i = 0; i < 500; i++) {
        const e = new MindEngine({ players: [{ id: 'you', human: true }, { id: 'b1' }], rng });
        const votes = [];
        e.on('starVote', (d) => votes.push(d));
        e.start(0);
        setHands(e, { you: [90], b1: [botCard] });
        const t = startPlay(e, 0);
        e.proposeStar('you', t);
        e.tick(t + BOTS_DOWN);
        assert.deepEqual(votes.map((v) => v.playerId), ['b1']);
        if (votes[0].agree) yes++;
      }
      return yes;
    };
    assert.equal(agreements(50, 21), 475);
    assert.equal(agreements(3, 23), 459);
    assert.equal(agreements(2, 22), 151);
  });
});

describe('pile direction', () => {
  it('Reverse plays one pile downward from 101, highest card first', () => {
    const { e } = makeGame({ bots: 1, variant: 'reverse' });
    e.start(0);
    assert.deepEqual(e.piles.map((p) => [p.id, p.dir, p.top]), [['down', -1, 101]]);
    assert.ok(e.players.every((p) => p.hand.every((c) => c.pile === 'down')));
    setHands(e, { you: [40, 90] });
    const t = startPlay(e, 0);
    e.humanPlay(null, t);
    assert.equal(e.pile('down').top, 90);
    e.humanPlay(null, t + 1000);
    assert.equal(e.pile('down').top, 40);
    assert.equal(e.lives, 2);
    assert.equal(e.phase, 'levelComplete');
  });

  it('in Reverse a higher card still held is a mistake', () => {
    const { e, events, t } = startedGame({ bots: 1, variant: 'reverse' }, { you: [60], b1: [80, 20] });
    e.humanPlay(null, t);
    assert.deepEqual(eventsOf(events, 'mistake')[0].offenders, [{ playerId: 'b1', cards: [80] }]);
    assert.deepEqual(values(e.player('b1')), [20]);
  });

  it('Dual has an up pile from 0 and a down pile from 101, judged separately', () => {
    const { e } = makeGame({ bots: 1, variant: 'dual' });
    e.start(0);
    assert.deepEqual(e.piles.map((p) => [p.id, p.dir, p.top]), [['up', 1, 0], ['down', -1, 101]]);
    assert.ok(e.players.every((p) => p.hand.every((c) => c.pile === 'up' || c.pile === 'down')));
    setHands(e, { you: [{ v: 30, pile: 'up' }, { v: 70, pile: 'down' }], b1: [{ v: 20, pile: 'down' }, { v: 50, pile: 'up' }] });
    const t = startPlay(e, 0);
    assert.equal(e.humanPlay('up', t), true);
    assert.equal(e.humanPlay('down', t + 100), true);
    assert.equal(e.pile('up').top, 30);
    assert.equal(e.pile('down').top, 70);
    assert.equal(e.lives, 2);
    assert.equal(e.humanPlay('up', t + 200), false);
  });

  it('in Dual a mistake only discards cards of the pile that was played', () => {
    const { e, events, t } = startedGame({ bots: 1, variant: 'dual' }, {
      you: [{ v: 70, pile: 'down' }],
      b1: [{ v: 90, pile: 'down' }, { v: 10, pile: 'up' }],
    });
    e.humanPlay(null, t);
    assert.deepEqual(eventsOf(events, 'mistake')[0].offenders, [{ playerId: 'b1', cards: [90] }]);
    assert.deepEqual(e.player('b1').hand, [{ v: 10, pile: 'up' }]);
  });
});

describe('Blind mode', () => {
  it('longestRun returns the indices of one longest increasing run', () => {
    assert.deepEqual([...longestRun([10, 30, 20, 40])].sort(), [0, 1, 3]);
    assert.deepEqual([...longestRun([30, 40, 10, 20])].sort(), [0, 1]);
    assert.equal(longestRun([50, 40, 30]).size, 1);
    assert.equal(longestRun([]).size, 0);
  });

  it('cards are judged only at the reveal, which uses longestRun', () => {
    const { e, events, t } = startedGame({ bots: 2, variant: 'blind', sigma: 0 }, { you: [30, 40], b1: [10, 20] });
    e.humanPlay(null, t);
    e.humanPlay(null, t);
    assert.equal(e.lives, 3);
    assert.equal(e.pile('up').top, 0);
    assert.equal(eventsOf(events, 'mistake').length, 0);
    assert.equal(e.callRefocus('you', t), false);

    const end = tickWhilePlaying(e, t);
    const order = e.pile('up').cards.map((c) => c.v);
    assert.deepEqual(order, [30, 40, 10, 20]);
    const run = longestRun(order);
    const [reveal] = eventsOf(events, 'reveal');
    assert.deepEqual(reveal.results.map((r) => r.ok), order.map((_, i) => run.has(i)));
    assert.deepEqual(reveal.results.map((r) => r.ok), [true, true, false, false]);
    assert.equal(reveal.wrong, 2);
    assert.equal(e.lives, 1);
    assert.equal(e.pile('up').top, 20);
    assert.equal(e.phase, 'resolving');
    e.tick(end + 60000);
    assert.equal(e.phase, 'levelComplete');
  });

  it('the reveal never costs more lives than are left', () => {
    const { e, events, t } = startedGame({ bots: 1, variant: 'blind', sigma: 0 }, { you: [60, 70, 80], b1: [10, 20, 30] });
    for (let i = 0; i < 3; i++) e.humanPlay(null, t);
    const end = tickWhilePlaying(e, t);
    assert.deepEqual(e.pile('up').cards.map((c) => c.v), [60, 70, 80, 10, 20, 30]);
    const [reveal] = eventsOf(events, 'reveal');
    assert.equal(reveal.wrong, 3);
    assert.equal(reveal.lives, 0);
    assert.equal(e.stats.mistakes, 3);
    assert.equal(e.stats.livesLost, 2);
    e.tick(end + 60000);
    assert.equal(e.phase, 'gameOver');
  });
});

describe('pause and resume', () => {
  it('pausing while resolving shifts the resolve deadline by the paused time', () => {
    const { e, events, t } = startedGame({ bots: 1 }, { you: [40], b1: [5, 60] });
    e.humanPlay(null, t);
    assert.equal(e.pause(t + 1000), true);
    assert.equal(e.phase, 'paused');
    assert.equal(e.pause(t + 1000), false);
    assert.equal(e.resume(t + 6000), true);
    assert.equal(e.phase, 'resolving');
    assert.equal(eventsOf(events, 'paused').length, 1);
    assert.equal(eventsOf(events, 'resumed').length, 1);
    e.tick(t + TIMING.mistakePause);
    assert.equal(e.phase, 'resolving');
    e.tick(t + TIMING.mistakePause + 5000);
    assert.equal(e.phase, 'sync');
  });

  it('pausing during the sync hold shifts the hold', () => {
    const { e } = makeGame();
    e.start(0);
    e.placeHand('you', 0);
    e.tick(BOTS_DOWN);
    assert.equal(e.allDownAt, BOTS_DOWN);
    e.pause(BOTS_DOWN + 500);
    e.resume(BOTS_DOWN + 2500);
    assert.equal(e.phase, 'sync');
    e.tick(BOTS_DOWN + 2000 + TIMING.syncHold - 1);
    assert.equal(e.phase, 'sync');
    e.tick(BOTS_DOWN + 2000 + TIMING.syncHold);
    assert.equal(e.phase, 'playing');
  });

  it('pausing a star vote shifts its deadline', () => {
    const { e, t } = startedGame({ bots: 1 }, { you: [10], b1: [50] });
    e.proposeStar('b1', t);
    e.pause(t + 1000);
    e.resume(t + 4000);
    assert.equal(e.vote.deadline, t + TIMING.voteTimeout + 3000);
    e.tick(t + TIMING.voteTimeout);
    assert.equal(e.phase, 'starVote');
    e.tick(t + TIMING.voteTimeout + 3000);
    assert.equal(e.phase, 'playing');
  });

  it('resuming a paused level goes back through a hands-down sync and shifts the pile clocks', () => {
    const { e, events, t } = startedGame({ bots: 1 }, { you: [10], b1: [50] });
    e.pause(t + 1000);
    e.resume(t + 6000);
    assert.equal(e.pile('up').clockStart, t + 5000);
    assert.equal(e.phase, 'sync');
    assert.deepEqual(eventsOf(events, 'syncStart').at(-1), { reason: 'pause' });
  });

  it('in Blind a paused level resumes straight into play and bot timing shifts by the paused time', () => {
    const { e, events, t } = startedGame({ bots: 1, variant: 'blind', sigma: 0 }, { you: [90], b1: [10] });
    const due = t + botDelay(10);
    e.pause(t + 1000);
    e.resume(t + 6000);
    assert.equal(e.phase, 'playing');
    assert.equal(e.blindStart, t + 5000);
    e.tick(due + 5000 - 1);
    assert.equal(eventsOf(events, 'play').length, 0);
    e.tick(due + 5000);
    assert.deepEqual(eventsOf(events, 'play').map((d) => [d.playerId, d.card.v, d.blind]), [['b1', 10, true]]);
  });

  it('pause and resume are refused when there is nothing to pause or resume', () => {
    const { e } = makeGame({ bots: 1 });
    assert.equal(e.pause(0), false);
    assert.equal(e.resume(0), false);
    e.start(0);
    setHands(e, { you: [50] });
    const t = startPlay(e, 0);
    e.humanPlay(null, t);
    assert.equal(e.phase, 'levelComplete');
    assert.equal(e.pause(t), false);
  });
});

describe('refocus', () => {
  it('calling refocus during play starts a new hands-down sync', () => {
    const { e, events, t } = startedGame({ bots: 1 }, { you: [10], b1: [50] });
    assert.equal(e.callRefocus('you', t + 100), true);
    assert.equal(e.phase, 'sync');
    assert.deepEqual(eventsOf(events, 'refocusCalled'), [{ playerId: 'you' }]);
    assert.deepEqual(eventsOf(events, 'syncStart').at(-1), { reason: 'refocus' });
    assert.equal(e.callRefocus('you', t + 200), false);
  });
});

describe('seeded bot-only games (bot timing and decisions)', () => {
  const GOLDEN = [
    {
      seed: 7, variant: 'classic', endedAt: 406736,
      end: { phase: 'victory', level: 10, lives: 1, stars: 2 },
      stats: { plays: 156, mistakes: 5, livesLost: 5, starsUsed: 1, perfectSyncs: 20, flawlessLevels: 7, levelsCleared: 10 },
      counts: { levelStart: 10, syncStart: 15, handDown: 45, allHandsDown: 15, playing: 17, play: 156, levelComplete: 9, perfectSync: 20, mistake: 5, starProposed: 2, starVote: 4, starRejected: 1, star: 1, victory: 1 },
    },
    {
      seed: 3, variant: 'reverse', endedAt: 351072,
      end: { phase: 'gameOver', level: 9, lives: 0, stars: 2 },
      stats: { plays: 120, mistakes: 5, livesLost: 5, starsUsed: 1, perfectSyncs: 19, flawlessLevels: 4, levelsCleared: 8 },
      counts: { levelStart: 9, syncStart: 13, handDown: 39, allHandsDown: 13, playing: 15, play: 120, levelComplete: 8, perfectSync: 19, mistake: 5, starProposed: 2, starVote: 4, starRejected: 1, star: 1, gameOver: 1 },
    },
    {
      seed: 5, variant: 'blind', endedAt: 189168,
      end: { phase: 'gameOver', level: 5, lives: 0, stars: 1 },
      stats: { plays: 42, mistakes: 4, livesLost: 4, starsUsed: 1, perfectSyncs: 0, flawlessLevels: 2, levelsCleared: 4 },
      counts: { levelStart: 5, syncStart: 5, handDown: 15, allHandsDown: 5, playing: 6, play: 42, reveal: 5, levelComplete: 4, starProposed: 1, starVote: 2, star: 1, gameOver: 1 },
    },
    {
      seed: 11, variant: 'dual', endedAt: 388546,
      end: { phase: 'victory', level: 10, lives: 1, stars: 1 },
      stats: { plays: 148, mistakes: 5, livesLost: 5, starsUsed: 2, perfectSyncs: 8, flawlessLevels: 6, levelsCleared: 10 },
      counts: { levelStart: 10, syncStart: 15, handDown: 45, allHandsDown: 15, playing: 17, play: 148, levelComplete: 9, perfectSync: 8, mistake: 5, starProposed: 2, starVote: 4, star: 2, victory: 1 },
    },
  ];

  function playOut(seed, variant) {
    const { e, events } = makeGame({ bots: 3, human: false, variant, seed });
    e.start(0);
    for (let t = 16; !['victory', 'gameOver'].includes(e.phase) && t < 3600000; t += 16) {
      e.tick(t);
      if (e.phase === 'levelComplete') e.nextLevel(t);
    }
    return { e, events };
  }

  for (const g of GOLDEN) {
    it(`${g.variant} seed ${g.seed} always plays out the same way`, () => {
      const { e, events } = playOut(g.seed, g.variant);
      assert.deepEqual({ phase: e.phase, level: e.level, lives: e.lives, stars: e.stars }, g.end);
      const { startedAt, endedAt, ...stats } = e.stats;
      assert.equal(startedAt, 0);
      assert.equal(Math.round(endedAt), g.endedAt);
      assert.deepEqual(stats, g.stats);
      const counts = {};
      for (const { type } of events) counts[type] = (counts[type] || 0) + 1;
      assert.deepEqual(counts, g.counts);
      assert.deepEqual(playOut(g.seed, g.variant).events, events);
    });
  }
});
