/* The Mind – pure rules engine (no DOM). Works in the browser (window.MindEngine) and in Node (module.exports). */
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

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

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
      this.rng = o.rng || Math.random;
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
      const p = this.player(playerId || (this.human && this.human.id));
      if (!p || p.handDown) return false;
      p.handDown = true;
      this.emit('handDown', { playerId: p.id });
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
    humanPlay(pileId, now) {
      if (this.phase !== 'playing') return false;
      const h = this.human;
      if (!h) return false;
      const pid = pileId || (this.piles.find((p) => this.urgent(h, p.id)) || {}).id;
      if (!pid || !this.urgent(h, pid)) return false;
      this.play(h, pid, now);
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
      const proposer = this.player(playerId || (this.human && this.human.id));
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
      this.emit('starProposed', { proposer: proposer.id, needsHuman: !!this.human && !proposer.human });
      return true;
    }

    voteStar(agree, now) {
      if (this.phase !== 'starVote') return false;
      const h = this.human;
      if (!h || this.vote.votes[h.id] !== undefined) return false;
      this.vote.votes[h.id] = !!agree;
      this.emit('starVote', { playerId: h.id, agree: !!agree });
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
      this.emit('refocusCalled', { playerId: playerId || (this.human && this.human.id) });
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

    pause(now) {
      if (['idle', 'paused', 'gameOver', 'victory', 'levelComplete'].includes(this.phase)) return false;
      this.pausedFrom = this.phase;
      this.pausedAt = now;
      this.phase = 'paused';
      this.emit('paused', {});
      return true;
    }

    resume(now) {
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
      this.emit('resumed', {});
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
          const h = this.human;
          if (h && v.votes[h.id] === undefined && now >= v.deadline) {
            v.votes[h.id] = false;
            this.emit('starVote', { playerId: h.id, agree: false, timeout: true });
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
  }

  const api = { MindEngine, longestRun, LEVELS_BY_PLAYERS, LEVEL_REWARDS, MAX_LIVES, MAX_STARS, VARIANTS, DIFFICULTY, TIMING, mulberry32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Mind = api;
})(typeof window !== 'undefined' ? window : globalThis);
