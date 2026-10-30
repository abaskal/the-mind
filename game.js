// Pure game logic for "The Mind". No DOM access, so it can be unit-tested in Node.
(function (root) {
  'use strict';

  const LEVELS_BY_PLAYERS = { 2: 12, 3: 10, 4: 8 };
  const REWARDS = { 2: 'star', 3: 'life', 5: 'star', 6: 'life', 8: 'star', 9: 'life' };
  const MAX_LIVES = 5;
  const MAX_STARS = 3;

  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function createGame(numPlayers) {
    if (!LEVELS_BY_PLAYERS[numPlayers]) throw new Error('The Mind supports 2-4 players');
    return {
      numPlayers,
      maxLevel: LEVELS_BY_PLAYERS[numPlayers],
      level: 1,
      lives: numPlayers,
      stars: 1,
      hands: Array.from({ length: numPlayers }, () => []),
      pile: [],
      discarded: [],
      status: 'idle', // idle | playing | levelComplete | won | lost
      lastReward: null,
    };
  }

  function dealLevel(state, rng = Math.random) {
    const deck = shuffle(Array.from({ length: 100 }, (_, i) => i + 1), rng);
    state.hands = state.hands.map((_, p) =>
      deck.slice(p * state.level, (p + 1) * state.level).sort((a, b) => a - b));
    state.pile = [];
    state.discarded = [];
    state.lastReward = null;
    state.status = 'playing';
    return state;
  }

  function topCard(state) {
    return state.pile.length ? state.pile[state.pile.length - 1] : 0;
  }

  function lowestCard(state, player) {
    return state.hands[player].length ? state.hands[player][0] : null;
  }

  function cardsRemaining(state) {
    return state.hands.reduce((n, h) => n + h.length, 0);
  }

  function checkLevelEnd(state) {
    if (state.lives <= 0) {
      state.status = 'lost';
    } else if (cardsRemaining(state) === 0) {
      if (state.level >= state.maxLevel) {
        state.status = 'won';
      } else {
        const reward = REWARDS[state.level] || null;
        if (reward === 'life') state.lives = Math.min(MAX_LIVES, state.lives + 1);
        if (reward === 'star') state.stars = Math.min(MAX_STARS, state.stars + 1);
        state.lastReward = reward;
        state.status = 'levelComplete';
      }
    }
  }

  // Plays `card` from `player`'s hand. Any lower card still held by anyone is
  // discarded and the team loses one life for that mistake.
  function playCard(state, player, card) {
    if (state.status !== 'playing') throw new Error('Not in play');
    const hand = state.hands[player];
    const idx = hand.indexOf(card);
    if (idx === -1) throw new Error(`Player ${player} does not hold ${card}`);
    hand.splice(idx, 1);
    state.pile.push(card);

    const missed = [];
    state.hands.forEach((h, p) => {
      while (h.length && h[0] < card) missed.push({ player: p, card: h.shift() });
    });
    if (missed.length) {
      state.lives -= 1;
      state.discarded.push(...missed.map((m) => m.card));
    }
    checkLevelEnd(state);
    return { player, card, missed };
  }

  // Throwing star: every player discards their lowest card face up.
  function useStar(state) {
    if (state.status !== 'playing') throw new Error('Not in play');
    if (state.stars <= 0) throw new Error('No throwing stars left');
    state.stars -= 1;
    const revealed = [];
    state.hands.forEach((h, p) => {
      if (h.length) revealed.push({ player: p, card: h.shift() });
    });
    state.discarded.push(...revealed.map((r) => r.card));
    checkLevelEnd(state);
    return revealed;
  }

  function nextLevel(state, rng = Math.random) {
    if (state.status !== 'levelComplete') throw new Error('Level not complete');
    state.level += 1;
    return dealLevel(state, rng);
  }

  const api = {
    LEVELS_BY_PLAYERS, REWARDS, MAX_LIVES, MAX_STARS,
    createGame, dealLevel, playCard, useStar, nextLevel,
    topCard, lowestCard, cardsRemaining, shuffle,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TheMind = api;
})(typeof self !== 'undefined' ? self : this);
