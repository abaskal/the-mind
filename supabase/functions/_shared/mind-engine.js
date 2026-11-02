/**
 * The Mind – pure rules engine (no DOM). A classic script: sets `window.Mind` / `globalThis.Mind` in the
 * browser and Deno, and is the `module.exports` of Node `require()`. Times are always passed in (`now`, ms).
 *
 * Setup
 *   new Mind.MindEngine({ players: [{ id, name?, human? }], variant?, difficulty?, adapt?, seed?, rng? })
 *     2–4 players, any mix of humans and bots. `seed` (or `rng: Mind.mulberry32(seed)`) makes the game
 *     reproducible and saveable; without either, a random seed is used.
 *   engine.on(type | '*', fn) – events: levelStart, syncStart, handDown, allHandsDown, playing, play,
 *     perfectSync, mistake, starProposed, starVote, starRejected, star, refocusCalled, reveal,
 *     levelComplete, victory, gameOver, paused, resumed.
 *   engine.start(now) · engine.tick(now) – call tick at least when nextDeadline() has passed.
 *
 * Player actions – return true when applied, false (state unchanged, never throws) when not allowed
 *   playCard(playerId, pileId?, now)  plays the player's most urgent card (the client never picks a value);
 *                                     without pileId, the first pile where the player holds a card
 *   placeHand(playerId, now) · proposeStar(playerId, now) · voteStar(playerId, agree, now)
 *   callRefocus(playerId, now) · pause(playerId, now) · resume(playerId, now) · nextLevel(now)
 *   Offline single-human forms kept for index.html: humanPlay(pileId, now), voteStar(agree, now),
 *   pause(now), resume(now), and placeHand/proposeStar/callRefocus without a playerId.
 *   Star vote: the proposer counts as yes, every other human must vote; at the deadline a missing human
 *   vote counts as no, and one no rejects the star.
 *
 * Online support
 *   engine.toJSON() → plain JSON (includes the RNG state – server only, never send it to clients)
 *   Mind.MindEngine.fromJSON(json, opts?) → engine that continues exactly where it was; re-attach listeners
 *   engine.viewFor(playerId | null) → what one player may see: public table state and only their own hand.
 *     In Blind mode pile values are null until the level's reveal. null (spectator/log) gets no hand at all.
 *   Mind.redactEvent(type, data, forPlayerId, engine?) → copy of an event payload safe to send to that player
 *   engine.nextDeadline() → earliest time at which tick(now) changes the state, or null while waiting for
 *     a player. tick(now) before that time changes nothing.
 */
(function (global) {
  'use strict';

  const LEVELS_BY_PLAYERS = { 2: 12, 3: 10, 4: 8 };
  const LEVEL_REWARDS = { 2: 'star', 3: 'life', 5: 'star', 6: 'life', 8: 'star', 9: 'life' };
  const MAX_LIVES = 5;
  const MAX_STARS = 3;

  const VARIANTS = {
    classic: { piles: [{ id: 'up', dir: 1 }], blind: false },
    reverse: { piles: [{ id: 'down', dir: -1 }], blind: false },
    blind: { piles: [{ id: 'up', dir: 1 }], blind: true },
    dual: { piles: [{ id: 'up', dir: 1 }, { id: 'down', dir: -1 }], blind: false },
  };

  const DIFFICULTY = {
    easy: { tempo: 360, noise: 0.55 },
    normal: { tempo: 300, noise: 0.85 },
    hard: { tempo: 240, noise: 1.15 },
  };

  const TIMING = {
    base: 450, // reaction floor every player adds before playing (ms)
    minDelay: 260,
    syncHold: 1400, // how long all hands must stay down before a level (re)starts
    mistakePause: 2800,
    starPause: 2300,
    revealStep: 380,
    voteTimeout: 12000,
    perfectSyncWindow: 1000,
  };

  // Seeded RNG. The generator keeps its whole state in `rng.state`, so a game can be saved and continued:
  // mulberry32(rng.state) produces exactly the numbers rng would have produced next.
  function mulberry32(seed) {
    const rng = function () {
      const a = (rng.state = (rng.state + 0x6d2b79f5) >>> 0);
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    rng.state = seed >>> 0;
    return rng;
  }

  function randomSeed() {
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (c && typeof c.getRandomValues === 'function') return c.getRandomValues(new Uint32Array(1))[0];
    return Math.floor(Math.random() * 4294967296) >>> 0;
  }

  const clone = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));

  // Everything toJSON() saves besides the RNG state. Derived fields (variant, diff, blind) and listeners are rebuilt.
  const STATE_FORMAT = 'mind-engine/1';
  const STATE_KEYS = [
    'variantId', 'difficultyId', 'adapt', 'tempo', 'maxLevel', 'lives', 'stars', 'level', 'phase',
    'players', 'piles', 'discard', 'lastPlay', 'vote', 'stats',
    'levelMistakes', 'levelStarUsed', 'levelBotStarTried', 'botStar', 'blindStart', 'blindFrozenAt', 'revealed',
    'syncReason', 'allDownAt', 'resolveUntil', 'afterResolve', 'pausedFrom', 'pausedAt', 'pausedBy',
  ];

  // Indices of one longest strictly increasing subsequence: the fewest cards that have to be "out of order".
  function longestRun(vals) {
    const n = vals.length;
    const len = new Array(n).fill(1);
    const prev = new Array(n).fill(-1);
    let end = -1;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < i; j++) {
        if (vals[j] < vals[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
      }
      if (end < 0 || len[i] > len[end]) end = i;
    }
    const keep = new Set();
    for (let k = end; k >= 0; k = prev[k]) keep.add(k);
    return keep;
  }

  class MindEngine {
    constructor(opts) {
      const o = opts || {};
      this.rng = o.rng || mulberry32(o.seed != null ? o.seed : randomSeed());
      this.variantId = VARIANTS[o.variant] ? o.variant : 'classic';
      this.variant = VARIANTS[this.variantId];
      this.blind = this.variant.blind;
      this.difficultyId = DIFFICULTY[o.difficulty] ? o.difficulty : 'normal';
      this.diff = DIFFICULTY[this.difficultyId];
      this.adapt = o.adapt !== false;
      this.tempo = this.diff.tempo;
      this.players = (o.players || []).map((p, i) => ({
        id: p.id,
        name: p.name || p.id,
        human: !!p.human,
        sigma: p.sigma != null ? p.sigma : 0.15,
        pace: p.pace != null ? p.pace : 1,
        seat: i,
        hand: [],
        handDown: false,
        handDownAt: 0,
        plan: {},
      }));
      if (this.players.length < 2 || this.players.length > 4) {
        throw new Error('The Mind needs 2–4 players');
      }
      const n = this.players.length;
      // Blind is a short challenge campaign: half the levels, at most one life lost per level.
      this.maxLevel = o.maxLevel || (this.blind ? Math.ceil(LEVELS_BY_PLAYERS[n] / 2) : LEVELS_BY_PLAYERS[n]);
      this.lives = n;
      this.stars = 1;
      this.level = 0;
      this.phase = 'idle';
      this.piles = [];
      this.discard = [];
      this.listeners = {};
      this.lastPlay = null;
      this.vote = null;
      this.revealed = false;
      this.pausedBy = null;
      this.stats = {
        plays: 0, mistakes: 0, livesLost: 0, starsUsed: 0, perfectSyncs: 0,
        flawlessLevels: 0, levelsCleared: 0, startedAt: 0, endedAt: 0,
      };
    }

    /* ---------- events ---------- */
    on(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
      return this;
    }
    emit(type, data) {
      (this.listeners[type] || []).forEach((fn) => fn(data || {}, this));
      (this.listeners['*'] || []).forEach((fn) => fn(type, data || {}, this));
    }

    /* ---------- helpers ---------- */
    get human() { return this.players.find((p) => p.human); }
    player(id) { return this.players.find((p) => p.id === id); }
    pile(id) { return this.piles.find((p) => p.id === id); }
    gauss() {
      let u = 0, v = 0;
      while (u === 0) u = this.rng();
      while (v === 0) v = this.rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    dist(card, pile, from) {
      const ref = from != null ? from : pile.ref;
      return pile.dir > 0 ? card.v - ref : ref - card.v;
    }
    urgent(player, pileId) {
      const pile = this.pile(pileId);
      let best = null;
      for (const c of player.hand) {
        if (c.pile !== pileId) continue;
        if (!best || (pile.dir > 0 ? c.v < best.v : c.v > best.v)) best = c;
      }
      return best;
    }
    allEmpty() { return this.players.every((p) => p.hand.length === 0); }
    cardsLeft() { return this.players.reduce((s, p) => s + p.hand.length, 0); }
    rewardFor(level) { return LEVEL_REWARDS[level] || null; }
    removeCard(player, card) {
      const i = player.hand.indexOf(card);
      if (i >= 0) player.hand.splice(i, 1);
    }
    sortHand(player) {
      player.hand.sort((a, b) => (a.pile === b.pile ? a.v - b.v : a.pile === 'up' ? -1 : 1));
    }

    /* ---------- flow ---------- */
    start(now) {
      this.stats.startedAt = now;
      this.level = 0;
      this.startLevel(1, now);
    }

    startLevel(level, now) {
      this.level = level;
      const deck = [];
      for (let i = 1; i <= 100; i++) deck.push(i);
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      this.piles = this.variant.piles.map((p) => {
        const start = p.dir > 0 ? 0 : 101;
        return { id: p.id, dir: p.dir, top: start, ref: start, start, cards: [], clockStart: now };
      });
      const pileIds = this.piles.map((p) => p.id);
      for (const pl of this.players) {
        pl.hand = deck.splice(0, level).map((v) => ({
          v,
          pile: pileIds.length === 1 ? pileIds[0] : pileIds[Math.floor(this.rng() * pileIds.length)],
        }));
        this.sortHand(pl);
        pl.plan = {};
      }
      this.discard = [];
      this.lastPlay = null;
      this.levelMistakes = 0;
      this.levelStarUsed = false;
      this.levelBotStarTried = false;
      this.botStar = null;
      this.blindStart = null;
      this.revealed = false;
      this.emit('levelStart', { level, maxLevel: this.maxLevel, reward: this.rewardFor(level) });
      this.beginSync(now, 'level');
    }

    beginSync(now, reason) {
      this.phase = 'sync';
      this.botStar = null;
      this.syncReason = reason;
      this.allDownAt = null;
      const spread = reason === 'level' ? 1500 : 1000;
      for (const p of this.players) {
        p.handDown = false;
        p.plan = {};
        p.handDownAt = p.human ? 0 : now + 450 + this.rng() * spread;
      }
      this.emit('syncStart', { reason });
    }

    placeHand(playerId, now) {
      if (this.phase !== 'sync') return false;
      const p = this.player(playerId != null ? playerId : this.human && this.human.id);
      if (!p || p.handDown) return false;
      p.handDown = true;
      this.emit('handDown', { playerId: p.id });
      // The hold starts when the last hand goes down, so the saved state already carries its deadline.
      if (this.allDownAt == null && this.players.every((x) => x.handDown)) {
        this.allDownAt = now;
        this.emit('allHandsDown', { reason: this.syncReason });
      }
      return true;
    }

    startPlaying(now) {
      this.phase = 'playing';
      for (const p of this.players) p.handDown = false;
      for (const pile of this.piles) pile.clockStart = now;
      if (this.blind && this.blindStart == null) this.blindStart = now;
      this.emit('playing', { reason: this.syncReason });
      this.planAll(now);
      this.considerBotStar(now);
    }

    considerBotStar(now) {
      this.botStar = null;
      if (this.stars <= 0 || this.levelBotStarTried) return;
      const n = this.players.length;
      const left = this.cardsLeft();
      const desperate = this.lives === 1 && left >= n * 2;
      const lateGame = this.level >= this.maxLevel - 1 && left >= n * 3;
      if (!((desperate && this.rng() < 0.65) || (lateGame && this.rng() < 0.4))) return;
      const bots = this.players.filter((p) => !p.human && p.hand.length);
      if (!bots.length) return;
      this.levelBotStarTried = true;
      this.botStar = { by: bots[Math.floor(this.rng() * bots.length)].id, at: now + 1200 + this.rng() * 2000 };
    }

    /* ---------- bot timing ---------- */
    planBot(bot, pile, now) {
      const card = this.urgent(bot, pile.id);
      if (!card) { delete bot.plan[pile.id]; return; }
      let anchor, gap, sigma = bot.sigma * this.diff.noise;
      if (this.blind) {
        anchor = this.blindStart;
        gap = this.dist(card, pile, pile.start);
        sigma *= 0.5;
      } else {
        anchor = pile.clockStart;
        gap = this.dist(card, pile);
      }
      const mean = TIMING.base + Math.max(0, gap) * this.tempo * bot.pace;
      const at = Math.max(now + TIMING.minDelay, anchor + mean * Math.exp(this.gauss() * sigma));
      bot.plan[pile.id] = { card, at, planned: now };
    }

    planPile(pile, now) {
      for (const b of this.players) if (!b.human) this.planBot(b, pile, now);
    }

    planAll(now) {
      for (const pile of this.piles) this.planPile(pile, now);
    }

    nextBotPlay(bot) {
      let best = null;
      for (const id in bot.plan) {
        const pl = bot.plan[id];
        if (!best || pl.at < best.at) best = Object.assign({ pileId: id }, pl);
      }
      return best;
    }

    /* ---------- actions ---------- */
    // Offline single-human helper: plays the human's most urgent card.
    humanPlay(pileId, now) {
      const h = this.human;
      return h ? this.playCard(h.id, pileId, now) : false;
    }

    playCard(playerId, pileId, now) {
      if (now === undefined && typeof pileId === 'number') { now = pileId; pileId = null; }
      if (this.phase !== 'playing') return false;
      const p = this.player(playerId);
      if (!p || !p.human) return false;
      if (pileId != null && !this.pile(pileId)) return false;
      const pid = pileId != null ? pileId : (this.piles.find((x) => this.urgent(p, x.id)) || {}).id;
      if (!pid || !this.urgent(p, pid)) return false;
      this.play(p, pid, now);
      return true;
    }

    play(player, pileId, now) {
      const pile = this.pile(pileId);
      const card = this.urgent(player, pileId);
      if (!card) return;
      const elapsed = now - pile.clockStart;
      const gap = this.dist(card, pile);
      this.removeCard(player, card);
      delete player.plan[pileId];
      pile.cards.push({ v: card.v, by: player.id, at: now });
      this.stats.plays++;

      let offenders = [];
      if (!this.blind) {
        for (const p of this.players) {
          const low = p.hand.filter((c) => c.pile === pileId && (pile.dir > 0 ? c.v < card.v : c.v > card.v));
          if (low.length) offenders.push({ playerId: p.id, cards: low.map((c) => c.v) });
        }
        pile.top = card.v;
        pile.ref = card.v;
      }
      pile.clockStart = now;

      if (player.human && this.adapt && !this.blind && !offenders.length && gap >= 2 && elapsed > 0) {
        const observed = (elapsed - TIMING.base) / gap;
        const lo = this.diff.tempo * 0.55, hi = this.diff.tempo * 1.8;
        const clamped = Math.min(hi, Math.max(lo, observed));
        this.tempo = Math.round(this.tempo * 0.72 + clamped * 0.28);
      }

      const prev = this.lastPlay;
      this.lastPlay = { by: player.id, v: card.v, pile: pileId, at: now };
      this.emit('play', {
        playerId: player.id, card: { v: card.v, pile: pileId }, pileId, blind: this.blind,
        top: pile.top, count: pile.cards.length, gap, elapsed,
      });

      if (offenders.length) {
        this.handleMistake(now, player, card, pileId, offenders);
        return;
      }

      if (!this.blind && prev && prev.by !== player.id && prev.pile === pileId && now - prev.at <= TIMING.perfectSyncWindow) {
        this.stats.perfectSyncs++;
        this.emit('perfectSync', { a: prev, b: this.lastPlay, delta: now - prev.at });
      }

      if (this.allEmpty()) {
        this.endLevel(now);
      } else {
        this.planPile(pile, now);
      }
    }

    handleMistake(now, player, card, pileId, offenders) {
      this.lives = Math.max(0, this.lives - 1);
      this.stats.mistakes++;
      this.stats.livesLost++;
      this.levelMistakes++;
      for (const o of offenders) {
        const p = this.player(o.playerId);
        p.hand = p.hand.filter((c) => !(c.pile === pileId && o.cards.includes(c.v)));
        for (const v of o.cards) this.discard.push({ v, pile: pileId, by: o.playerId, reason: 'mistake' });
      }
      for (const p of this.players) p.plan = {};
      this.phase = 'resolving';
      this.resolveUntil = now + TIMING.mistakePause;
      this.afterResolve = this.lives <= 0 ? 'gameOver' : this.allEmpty() ? 'levelEnd' : 'refocus';
      this.emit('mistake', { playerId: player.id, card: { v: card.v, pile: pileId }, offenders, lives: this.lives });
    }

    proposeStar(playerId, now) {
      if (this.phase !== 'playing' || this.stars <= 0) return false;
      const proposer = this.player(playerId != null ? playerId : this.human && this.human.id);
      if (!proposer) return false;
      if (this.blind) this.blindFrozenAt = now;
      this.botStar = null;
      this.phase = 'starVote';
      this.vote = { proposer: proposer.id, votes: {}, pending: {}, deadline: now + TIMING.voteTimeout, startedAt: now };
      this.vote.votes[proposer.id] = true;
      for (const p of this.players) {
        if (p.id === proposer.id || p.human) continue;
        let near = false;
        for (const pile of this.piles) {
          const c = this.urgent(p, pile.id);
          if (c && this.dist(c, pile) <= 2) near = true;
        }
        const agree = this.rng() < (near ? 0.3 : 0.93);
        this.vote.pending[p.id] = { at: now + 650 + this.rng() * 1300, agree };
      }
      for (const p of this.players) p.plan = {};
      this.emit('starProposed', { proposer: proposer.id, needsHuman: this.players.some((p) => p.human && p.id !== proposer.id) });
      return true;
    }

    // voteStar(playerId, agree, now). The offline single-human form voteStar(agree, now) is still accepted.
    voteStar(playerId, agree, now) {
      if (typeof playerId === 'boolean') {
        const h = this.human;
        return h ? this.voteStar(h.id, playerId, agree) : false;
      }
      if (this.phase !== 'starVote' || !this.vote) return false;
      const p = this.player(playerId);
      if (!p || !p.human || this.vote.votes[p.id] !== undefined) return false;
      this.vote.votes[p.id] = !!agree;
      this.emit('starVote', { playerId: p.id, agree: !!agree });
      this.checkVote(now);
      return true;
    }

    checkVote(now) {
      const v = this.vote;
      const values = this.players.map((p) => v.votes[p.id]);
      if (values.some((x) => x === false)) {
        const by = this.players.find((p) => v.votes[p.id] === false).id;
        this.vote = null;
        this.emit('starRejected', { by });
        this.resumePlaying(now);
      } else if (values.every((x) => x === true)) {
        this.vote = null;
        this.applyStar(now);
      }
    }

    applyStar(now) {
      this.stars--;
      this.stats.starsUsed++;
      this.levelStarUsed = true;
      const discards = [];
      for (const pile of this.piles) {
        let minDiscard = null;
        for (const p of this.players) {
          const c = this.urgent(p, pile.id);
          if (!c) continue;
          this.removeCard(p, c);
          this.discard.push({ v: c.v, pile: pile.id, by: p.id, reason: 'star' });
          discards.push({ playerId: p.id, v: c.v, pile: pile.id });
          if (minDiscard == null || (pile.dir > 0 ? c.v < minDiscard : c.v > minDiscard)) minDiscard = c.v;
        }
        // Every remaining card is beyond the smallest revealed card, so it becomes the new timing reference.
        if (minDiscard != null && !this.blind) {
          pile.ref = pile.dir > 0 ? Math.max(pile.ref, minDiscard) : Math.min(pile.ref, minDiscard);
        }
      }
      this.phase = 'resolving';
      this.resolveUntil = now + TIMING.starPause;
      this.afterResolve = this.allEmpty() ? 'levelEnd' : 'resume';
      this.emit('star', { discards, stars: this.stars });
    }

    callRefocus(playerId, now) {
      if (this.phase !== 'playing' || this.blind) return false;
      const p = this.player(playerId != null ? playerId : this.human && this.human.id);
      if (!p) return false;
      this.emit('refocusCalled', { playerId: p.id });
      this.beginSync(now, 'refocus');
      return true;
    }

    resumePlaying(now) {
      this.phase = 'playing';
      for (const pile of this.piles) pile.clockStart = now;
      if (this.blind && this.blindFrozenAt != null) {
        this.blindStart += now - this.blindFrozenAt;
        this.blindFrozenAt = null;
      }
      this.planAll(now);
      this.emit('playing', { reason: 'resume' });
    }

    endLevel(now) {
      if (this.blind) {
        const results = [];
        let wrong = 0;
        for (const pile of this.piles) {
          const inOrder = longestRun(pile.cards.map((c) => c.v * pile.dir));
          pile.cards.forEach((c, i) => {
            const ok = inOrder.has(i);
            if (!ok) wrong++;
            results.push({ pile: pile.id, index: i, v: c.v, by: c.by, ok });
          });
          pile.top = pile.cards.length ? pile.cards[pile.cards.length - 1].v : pile.start;
        }
        this.levelMistakes += wrong;
        this.stats.mistakes += wrong;
        const lost = Math.min(this.lives, wrong);
        this.stats.livesLost += lost;
        this.lives -= lost;
        this.phase = 'resolving';
        this.resolveUntil = now + 900 + results.length * TIMING.revealStep + (wrong ? 1400 : 600);
        this.afterResolve = this.lives <= 0 ? 'gameOver' : 'levelDone';
        this.revealed = true;
        this.emit('reveal', { results, wrong, lives: this.lives });
        return;
      }
      this.levelDone(now);
    }

    levelDone(now) {
      const flawless = this.levelMistakes === 0 && !this.levelStarUsed;
      if (flawless) this.stats.flawlessLevels++;
      this.stats.levelsCleared = this.level;
      if (this.level >= this.maxLevel) {
        this.phase = 'victory';
        this.stats.endedAt = now;
        this.emit('victory', { level: this.level, flawless });
        return;
      }
      const reward = this.rewardFor(this.level);
      let applied = false;
      if (reward === 'life' && this.lives < MAX_LIVES) { this.lives++; applied = true; }
      if (reward === 'star' && this.stars < MAX_STARS) { this.stars++; applied = true; }
      this.phase = 'levelComplete';
      this.emit('levelComplete', { level: this.level, reward, applied, flawless, lives: this.lives, stars: this.stars });
    }

    nextLevel(now) {
      if (this.phase !== 'levelComplete') return false;
      this.startLevel(this.level + 1, now);
      return true;
    }

    // pause(playerId, now) / resume(playerId, now). The offline forms pause(now) / resume(now) are still accepted.
    pause(playerId, now) {
      let by = null;
      if (now === undefined && typeof playerId === 'number') now = playerId;
      else {
        const p = this.player(playerId);
        if (!p) return false;
        by = p.id;
      }
      if (['idle', 'paused', 'gameOver', 'victory', 'levelComplete'].includes(this.phase)) return false;
      this.pausedFrom = this.phase;
      this.pausedAt = now;
      this.pausedBy = by;
      this.phase = 'paused';
      this.emit('paused', by ? { playerId: by } : {});
      return true;
    }

    resume(playerId, now) {
      let by = null;
      if (now === undefined && typeof playerId === 'number') now = playerId;
      else {
        const p = this.player(playerId);
        if (!p) return false;
        by = p.id;
      }
      if (this.phase !== 'paused') return false;
      const d = now - this.pausedAt;
      const from = this.pausedFrom;
      if (this.blindStart != null) this.blindStart += d;
      if (this.resolveUntil) this.resolveUntil += d;
      if (this.allDownAt) this.allDownAt += d;
      if (this.vote) {
        this.vote.deadline += d;
        for (const id in this.vote.pending) this.vote.pending[id].at += d;
      }
      for (const p of this.players) {
        if (p.handDownAt) p.handDownAt += d;
        for (const k in p.plan) p.plan[k].at += d;
      }
      for (const pile of this.piles) pile.clockStart += d;
      this.pausedBy = null;
      this.emit('resumed', by ? { playerId: by } : {});
      if (from === 'playing' && !this.blind) {
        this.beginSync(now, 'pause');
      } else {
        this.phase = from;
      }
      return true;
    }

    /* ---------- clock ---------- */
    tick(now) {
      switch (this.phase) {
        case 'sync': {
          for (const p of this.players) {
            if (!p.human && !p.handDown && now >= p.handDownAt) {
              p.handDown = true;
              this.emit('handDown', { playerId: p.id });
            }
          }
          if (this.players.every((p) => p.handDown)) {
            if (this.allDownAt == null) {
              this.allDownAt = now;
              this.emit('allHandsDown', { reason: this.syncReason });
            } else if (now - this.allDownAt >= TIMING.syncHold) {
              this.startPlaying(now);
            }
          }
          break;
        }
        case 'playing': {
          let guard = 0;
          while (this.phase === 'playing' && guard++ < 50) {
            let due = null, dueBot = null;
            for (const b of this.players) {
              if (b.human) continue;
              const n = this.nextBotPlay(b);
              if (n && n.at <= now && (!due || n.at < due.at)) { due = n; dueBot = b; }
            }
            if (!due) break;
            this.play(dueBot, due.pileId, Math.max(due.at, now - 30));
          }
          if (this.phase === 'playing' && this.botStar && now >= this.botStar.at) {
            const by = this.botStar.by;
            this.botStar = null;
            this.proposeStar(by, now);
          }
          break;
        }
        case 'starVote': {
          const v = this.vote;
          for (const id in v.pending) {
            if (now >= v.pending[id].at) {
              v.votes[id] = v.pending[id].agree;
              delete v.pending[id];
              this.emit('starVote', { playerId: id, agree: v.votes[id] });
            }
          }
          for (const p of this.players) {
            if (p.human && v.votes[p.id] === undefined && now >= v.deadline) {
              v.votes[p.id] = false;
              this.emit('starVote', { playerId: p.id, agree: false, timeout: true });
            }
          }
          if (Object.keys(v.pending).length === 0 || Object.values(v.votes).includes(false)) this.checkVote(now);
          break;
        }
        case 'resolving': {
          if (now >= this.resolveUntil) {
            const next = this.afterResolve;
            this.afterResolve = null;
            if (next === 'gameOver') {
              this.phase = 'gameOver';
              this.stats.endedAt = now;
              this.emit('gameOver', { level: this.level });
            } else if (next === 'levelEnd') {
              this.endLevel(now);
            } else if (next === 'levelDone') {
              this.levelDone(now);
            } else if (next === 'refocus') {
              this.beginSync(now, 'mistake');
            } else {
              this.resumePlaying(now);
            }
          }
          break;
        }
        default:
          break;
      }
    }

    /* Used by the UI for the "eye contact" house rule: how close a bot is to playing (0–1). */
    tension(bot, now) {
      if (this.phase !== 'playing') return 0;
      const n = this.nextBotPlay(bot);
      if (!n) return 0;
      const total = Math.max(1, n.at - n.planned);
      return Math.max(0, Math.min(1, 1 - (n.at - now) / Math.min(total, 2500)));
    }

    /* ---------- online support ---------- */
    nextDeadline() {
      let best = null;
      const consider = (t) => { if (t != null && (best == null || t < best)) best = t; };
      switch (this.phase) {
        case 'sync':
          if (this.allDownAt != null) consider(this.allDownAt + TIMING.syncHold);
          else for (const p of this.players) if (!p.human && !p.handDown) consider(p.handDownAt);
          break;
        case 'playing':
          for (const p of this.players) {
            if (p.human) continue;
            const n = this.nextBotPlay(p);
            if (n) consider(n.at);
          }
          if (this.botStar) consider(this.botStar.at);
          break;
        case 'starVote':
          for (const id in this.vote.pending) consider(this.vote.pending[id].at);
          if (this.players.some((p) => p.human && this.vote.votes[p.id] === undefined)) consider(this.vote.deadline);
          break;
        case 'resolving':
          consider(this.resolveUntil);
          break;
        default:
          break;
      }
      return best;
    }

    toJSON() {
      if (typeof this.rng.state !== 'number') {
        throw new Error('MindEngine: this rng cannot be saved. Create the engine with opts.seed or opts.rng = Mind.mulberry32(seed).');
      }
      const out = { format: STATE_FORMAT, rngState: this.rng.state };
      for (const k of STATE_KEYS) out[k] = clone(this[k]);
      return out;
    }

    static fromJSON(json, opts) {
      const s = typeof json === 'string' ? JSON.parse(json) : json;
      if (!s || s.format !== STATE_FORMAT) throw new Error('MindEngine.fromJSON: unsupported state format');
      const o = opts || {};
      const e = new MindEngine({
        players: s.players, variant: s.variantId, difficulty: s.difficultyId, adapt: s.adapt, maxLevel: s.maxLevel,
        rng: o.rng || mulberry32(s.rngState),
      });
      for (const k of STATE_KEYS) e[k] = clone(s[k]);
      // A bot plan points at a card in that bot's hand; re-link it to the restored hand object.
      for (const p of e.players) {
        for (const id in p.plan) {
          const c = p.plan[id].card;
          p.plan[id].card = p.hand.find((h) => h.v === c.v && h.pile === c.pile) || c;
        }
      }
      return e;
    }

    viewFor(playerId) {
      const me = playerId != null ? this.player(playerId) || null : null;
      const hide = this.blind && !this.revealed;
      const v = this.vote;
      return {
        you: me ? me.id : null,
        phase: this.phase,
        level: this.level,
        maxLevel: this.maxLevel,
        lives: this.lives,
        stars: this.stars,
        variant: this.variantId,
        syncReason: this.syncReason || null,
        pausedFrom: this.phase === 'paused' ? this.pausedFrom : null,
        pausedBy: this.phase === 'paused' ? this.pausedBy || null : null,
        piles: this.piles.map((p) => ({
          id: p.id,
          dir: p.dir,
          count: p.cards.length,
          top: hide ? null : p.top,
          cards: p.cards.map((c) => ({ v: hide ? null : c.v, by: c.by, at: c.at })),
        })),
        discard: this.discard.map((d) => ({ v: d.v, pile: d.pile, by: d.by, reason: d.reason })),
        lastPlay: this.lastPlay
          ? { by: this.lastPlay.by, pile: this.lastPlay.pile, at: this.lastPlay.at, v: hide ? null : this.lastPlay.v }
          : null,
        vote: v ? { proposer: v.proposer, votes: Object.assign({}, v.votes), deadline: v.deadline, startedAt: v.startedAt } : null,
        deadlines: {
          syncHold: this.phase === 'sync' && this.allDownAt != null ? this.allDownAt + TIMING.syncHold : null,
          resolve: this.phase === 'resolving' ? this.resolveUntil : null,
          vote: this.phase === 'starVote' && v ? v.deadline : null,
        },
        players: this.players.map((p) => ({
          id: p.id, name: p.name, human: p.human, seat: p.seat, handCount: p.hand.length, handDown: p.handDown,
        })),
        hand: me ? me.hand.map((c) => ({ v: c.v, pile: c.pile })) : null,
        stats: Object.assign({}, this.stats),
      };
    }
  }

  // Removes every hand that does not belong to the viewer: `hands` maps keyed by player id and `hand` fields
  // on objects that name another player.
  function stripForeignHands(node, viewer) {
    if (Array.isArray(node)) {
      node.forEach((x) => stripForeignHands(x, viewer));
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (node.hands && typeof node.hands === 'object') {
      for (const id of Object.keys(node.hands)) if (viewer == null || id !== String(viewer)) delete node.hands[id];
    }
    if ('hand' in node) {
      const owner = node.playerId != null ? node.playerId : node.id;
      if (viewer == null || owner !== viewer) node.hand = null;
    }
    for (const k of Object.keys(node)) stripForeignHands(node[k], viewer);
  }

  function redactEvent(type, data, forPlayerId, engine) {
    const d = clone(data || {});
    const blind = d.blind != null ? !!d.blind : !!(engine && engine.blind);
    // A Blind card is always played before its level's reveal, so its value, the pile top and the gap
    // (which is the card value measured from the pile start) stay hidden.
    if (type === 'play' && blind) {
      if (d.card) d.card.v = null;
      d.top = null;
      d.gap = null;
    }
    stripForeignHands(d, forPlayerId);
    return d;
  }

  const api = { MindEngine, longestRun, LEVELS_BY_PLAYERS, LEVEL_REWARDS, MAX_LIVES, MAX_STARS, VARIANTS, DIFFICULTY, TIMING, mulberry32, redactEvent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Mind = api;
})(typeof window !== 'undefined' ? window : globalThis);
