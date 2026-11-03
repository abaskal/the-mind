/* Pure helpers for the online table (MIND-06): the server clock offset, the event sequencer, seat rotation, the
 * mapping from public_state + your own hand to what the table UI reads, and missing-player tracking. No DOM and no
 * network, so Node tests require() this file; the browser loads it as a classic script (window.MindOnlineSync). */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MindOnlineSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GAP_MS = 1000;
  const MISSING_PAUSE_MS = 5000;
  const END_GAME_AFTER_PAUSE_MS = 3 * 60 * 1000;
  const PAUSE_PHASES = ['sync', 'playing', 'starVote'];
  const ENDED_PHASES = ['victory', 'gameOver'];
  // Seat colors by room seat (0–3), so a player keeps their color on every screen.
  const SEAT_COLORS = ['#5ef2ff', '#ff5ea8', '#ffd166', '#8bff9a'];
  // Same table as POS in index.html (UI.layoutSeats): where the other players sit, clockwise from you at the bottom.
  const POS = { 1: ['top'], 2: ['top-left', 'top-right'], 3: ['left', 'top', 'right'] };

  /**
   * Server clock estimate from request round trips. Each sample is (local send time, local receive time, server
   * time in the reply); offset = serverNow + rtt / 2 − localReceive. The sample with the smallest round trip among
   * the last `maxSamples` wins, because its unknown one-way asymmetry is the smallest.
   */
  function createClock(opts) {
    const maxSamples = (opts && opts.maxSamples) || 20;
    const samples = [];
    let best = null;
    return {
      sample(sentAt, receivedAt, serverNow) {
        const rtt = receivedAt - sentAt;
        if (!Number.isFinite(rtt) || rtt < 0 || !Number.isFinite(serverNow)) return false;
        samples.push({ rtt, offset: serverNow + rtt / 2 - receivedAt });
        if (samples.length > maxSamples) samples.shift();
        const prev = best;
        best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        return !prev || prev.offset !== best.offset;
      },
      get ready() { return best != null; },
      get offset() { return best ? best.offset : null; },
      get rtt() { return best ? best.rtt : null; },
      serverNow(localNow) { return best ? localNow + best.offset : null; },
      toLocal(serverTime) { return best && serverTime != null ? serverTime - best.offset : null; },
    };
  }

  /**
   * Delivers events strictly in `seq` order. Events that arrive early wait in a buffer; duplicates (seq already
   * delivered or buffered) are dropped. If a gap stays open for `gapMs`, onGap() asks for a fresh snapshot, after
   * which reset(lastSeq) continues from it. Nothing is delivered before the first reset().
   */
  function createSequencer(opts) {
    const onEvent = opts.onEvent;
    const onGap = opts.onGap || (() => {});
    const gapMs = opts.gapMs != null ? opts.gapMs : GAP_MS;
    const schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
    const cancel = opts.cancel || ((id) => clearTimeout(id));
    const buffer = new Map();
    let last = 0;
    let started = false;
    let timer = null;

    function fire() {
      timer = null;
      if (buffer.size) onGap();
    }
    function drain() {
      if (!started) return 0;
      let n = 0;
      while (buffer.has(last + 1)) {
        const ev = buffer.get(last + 1);
        buffer.delete(last + 1);
        last++;
        n++;
        onEvent(ev);
      }
      if (buffer.size) {
        if (timer == null) timer = schedule(fire, gapMs);
      } else if (timer != null) {
        cancel(timer);
        timer = null;
      }
      return n;
    }
    return {
      /** → how many events were delivered by this call. */
      push(ev) {
        if (!ev || !Number.isInteger(ev.seq) || ev.seq < 1) return 0;
        if (started && ev.seq <= last) return 0;
        if (!buffer.has(ev.seq)) buffer.set(ev.seq, ev);
        return drain();
      },
      /** Continue after `lastSeq` (e.g. from a snapshot): older buffered events are dropped, newer ones delivered. */
      reset(lastSeq) {
        started = true;
        last = Math.max(last, Number.isInteger(lastSeq) ? lastSeq : 0);
        for (const k of Array.from(buffer.keys())) if (k <= last) buffer.delete(k);
        if (timer != null) { cancel(timer); timer = null; }
        return drain();
      },
      get started() { return started; },
      get lastSeq() { return last; },
      get pending() { return buffer.size; },
      dispose() {
        if (timer != null) cancel(timer);
        timer = null;
        buffer.clear();
      },
    };
  }

  /** The room seat (0–3) of an engine player id `s<seat>`. */
  function seatNumber(p) {
    const m = /^s(\d+)$/.exec(String(p && p.id));
    return m ? Number(m[1]) : Number(p && p.seat) || 0;
  }

  /** You first, then the other players clockwise in seat order (the seat after yours comes next, wrapping round). */
  function seatOrder(players, meId) {
    const list = (players || []).slice().sort((a, b) => seatNumber(a) - seatNumber(b));
    const i = list.findIndex((p) => p.id === meId);
    return i < 0 ? list : list.slice(i).concat(list.slice(0, i));
  }

  /** Where everybody sits: you at the bottom, the others in POS order. → [{ id, pos }] */
  function seatLayout(players, meId) {
    const order = seatOrder(players, meId);
    const others = order.filter((p) => p.id !== meId);
    const pos = POS[others.length] || POS[3];
    return order.map((p) => ({ id: p.id, pos: p.id === meId ? 'bottom' : pos[others.indexOf(p)] }));
  }

  const seatColor = (p) => SEAT_COLORS[seatNumber(p) % SEAT_COLORS.length];

  /** The public part of a view: viewFor(me) without your hand, so it can be stored and compared like public_state. */
  function publicPart(view) {
    if (!view || typeof view !== 'object') return null;
    const out = Object.assign({}, view);
    delete out.hand;
    delete out.you;
    return out;
  }

  /**
   * What the table UI reads, built from the newest public_state and your own hand row. Server times become local
   * times through toLocal(serverMs). Other players' hands are placeholders of the right length; only yours has
   * values (I2).
   *   opts: { toLocal, syncHoldMs, variants (Mind.VARIANTS) }
   */
  function mapState(ps, hand, meId, opts) {
    const o = opts || {};
    const toLocal = o.toLocal || ((x) => x);
    const local = (x) => (x == null ? null : toLocal(x));
    const variants = o.variants || {};
    const variant = ps.variant;
    const blind = variants[variant] ? !!variants[variant].blind : variant === 'blind';
    const piles = (ps.piles || []).map((p) => {
      const start = p.dir > 0 ? 0 : 101;
      const top = p.top == null ? start : p.top;
      return {
        id: p.id, dir: p.dir, start, top, ref: top, count: p.count,
        cards: (p.cards || []).map((c) => ({ v: c.v, by: c.by, at: local(c.at) })),
      };
    });
    const players = seatOrder(ps.players, meId).map((p) => ({
      id: p.id,
      name: p.name,
      human: p.id === meId,
      seat: seatNumber(p),
      handDown: !!p.handDown,
      handCount: p.handCount,
      hand: p.id === meId
        ? (hand || []).map((c) => ({ v: c.v, pile: c.pile }))
        : Array.from({ length: p.handCount || 0 }, () => ({ v: null, pile: null })),
    }));
    const deadlines = ps.deadlines || {};
    const ended = ENDED_PHASES.includes(ps.phase);
    return {
      phase: ps.phase,
      level: ps.level,
      maxLevel: ps.maxLevel,
      lives: ps.lives,
      stars: ps.stars,
      variantId: variant,
      blind,
      revealed: blind && piles.length > 0 && ps.piles[0].top != null,
      syncReason: ps.syncReason || null,
      pausedBy: ps.pausedBy || null,
      pausedFrom: ps.pausedFrom || null,
      piles,
      discard: (ps.discard || []).map((d) => ({ v: d.v, pile: d.pile, by: d.by, reason: d.reason })),
      lastPlay: ps.lastPlay ? Object.assign({}, ps.lastPlay, { at: local(ps.lastPlay.at) }) : null,
      vote: ps.vote
        ? { proposer: ps.vote.proposer, votes: Object.assign({}, ps.vote.votes), deadline: local(ps.vote.deadline), startedAt: local(ps.vote.startedAt) }
        : null,
      allDownAt: deadlines.syncHold != null ? local(deadlines.syncHold - (o.syncHoldMs || 0)) : null,
      resolveUntil: local(deadlines.resolve),
      stats: Object.assign({}, ps.stats),
      players,
      result: ps.result || (ended
        ? { won: ps.phase === 'victory', level: ps.level, maxLevel: ps.maxLevel, stats: Object.assign({}, ps.stats), variant }
        : null),
    };
  }

  /** userId → local time since when that seated player has been missing from Presence. */
  function trackMissing(prev, seatedIds, onlineIds, now) {
    const next = new Map();
    for (const id of seatedIds) {
      if (onlineIds.has(id)) continue;
      next.set(id, prev && prev.has(id) ? prev.get(id) : now);
    }
    return next;
  }

  /** Seated players missing for at least `ms`. */
  function overdue(missing, now, ms) {
    const limit = ms != null ? ms : MISSING_PAUSE_MS;
    return Array.from(missing).filter(([, since]) => now - since >= limit).map(([id]) => id);
  }

  /** Whether a connected client should pause the table because somebody has been gone too long. */
  function shouldPause(phase, missing, now) {
    return PAUSE_PHASES.includes(phase) && overdue(missing, now).length > 0;
  }

  /** endGame is allowed once the table has been paused for 3 minutes by the server clock. */
  function canEndGame(phase, pausedAtServer, serverNow) {
    return phase === 'paused' && pausedAtServer != null && serverNow != null && serverNow - pausedAtServer >= END_GAME_AFTER_PAUSE_MS;
  }

  /** Whether a stored deadline has passed on the server clock. */
  const isDue = (deadline, serverNow) => deadline != null && serverNow != null && serverNow >= deadline;

  return {
    GAP_MS, MISSING_PAUSE_MS, END_GAME_AFTER_PAUSE_MS, PAUSE_PHASES, SEAT_COLORS, POS,
    createClock, createSequencer, seatNumber, seatOrder, seatLayout, seatColor, publicPart, mapState,
    trackMissing, overdue, shouldPause, canEndGame, isDue,
  };
});
