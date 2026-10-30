const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./game.js');

function withHands(players, hands, overrides = {}) {
  const s = M.createGame(players);
  s.hands = hands.map((h) => h.slice().sort((a, b) => a - b));
  s.status = 'playing';
  return Object.assign(s, overrides);
}

test('setup follows player-count rules', () => {
  assert.equal(M.createGame(2).maxLevel, 12);
  assert.equal(M.createGame(3).maxLevel, 10);
  assert.equal(M.createGame(4).maxLevel, 8);
  assert.equal(M.createGame(3).lives, 3);
  assert.equal(M.createGame(3).stars, 1);
  assert.throws(() => M.createGame(5));
});

test('deal gives level-many unique sorted cards per player', () => {
  const s = M.createGame(4);
  s.level = 8;
  M.dealLevel(s);
  const all = s.hands.flat();
  assert.equal(all.length, 32);
  assert.equal(new Set(all).size, 32);
  s.hands.forEach((h) => assert.deepEqual(h, h.slice().sort((a, b) => a - b)));
});

test('correct play keeps lives', () => {
  const s = withHands(2, [[10, 50], [30]]);
  M.playCard(s, 0, 10);
  M.playCard(s, 1, 30);
  M.playCard(s, 0, 50);
  assert.equal(s.lives, 2);
  assert.deepEqual(s.pile, [10, 30, 50]);
  assert.equal(s.status, 'levelComplete');
});

test('mistake discards all lower cards and costs one life', () => {
  const s = withHands(3, [[40], [5, 20, 60], [15]]);
  const r = M.playCard(s, 0, 40);
  assert.equal(s.lives, 2);
  assert.deepEqual(r.missed.map((m) => m.card).sort((a, b) => a - b), [5, 15, 20]);
  assert.deepEqual(s.hands, [[], [60], []]);
});

test('losing last life ends the game', () => {
  const s = withHands(2, [[40], [5, 90]], { lives: 1 });
  M.playCard(s, 0, 40);
  assert.equal(s.status, 'lost');
});

test('throwing star discards everyone\'s lowest card', () => {
  const s = withHands(3, [[10, 70], [20], []]);
  const revealed = M.useStar(s);
  assert.deepEqual(revealed.map((r) => r.card), [10, 20]);
  assert.equal(s.stars, 0);
  assert.deepEqual(s.hands, [[70], [], []]);
  assert.throws(() => M.useStar(s));
});

test('rewards granted on levels 2, 3 and capped', () => {
  const s = withHands(2, [[1], []], { level: 2 });
  M.playCard(s, 0, 1);
  assert.equal(s.lastReward, 'star');
  assert.equal(s.stars, 2);

  const t = withHands(2, [[1], []], { level: 3, lives: 5 });
  M.playCard(t, 0, 1);
  assert.equal(t.lastReward, 'life');
  assert.equal(t.lives, M.MAX_LIVES);
});

test('clearing the final level wins', () => {
  const s = withHands(4, [[99], [], [], []], { level: 8 });
  M.playCard(s, 0, 99);
  assert.equal(s.status, 'won');
});

test('nextLevel advances and deals', () => {
  const s = withHands(2, [[1], []]);
  M.playCard(s, 0, 1);
  M.nextLevel(s);
  assert.equal(s.level, 2);
  assert.equal(s.hands[0].length, 2);
  assert.equal(s.status, 'playing');
});
