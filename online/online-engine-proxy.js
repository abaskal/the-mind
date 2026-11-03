/* Online engine proxy (MIND-06). It looks like a MindEngine to the table UI in index.html: the same fields (phase,
 * level, lives, stars, piles, players, vote, …), the same on() events and the same action methods. Underneath:
 *   - state is the newest rooms.public_state by version plus your own room_hands row (the server is the referee, I1);
 *   - events (room_events, or the events of an action's reply) are emitted strictly in seq order, after the state
 *     they lead to has been applied, so the existing animations and sounds run unchanged;
 *   - actions call the room-action Edge Function; the server decides everything (I1, I3).
 * Rules are never re-implemented here: the few engine helpers the UI calls (urgent, rewardFor) are the engine's own
 * methods (I4). Other players' hands are placeholders of the right length (I2).
 * UMD: Node tests require() it with a fake transport; the browser gets window.MindOnlineProxy. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MindOnlineProxy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FLUSH_MS = 20;
  const HAND_WAIT_MS = 400;
  const TICK_JITTER_MS = 150;
  const TICK_RETRY_MS = 1000;
  const TICK_ROUND_MS = 2500;
  const CLOCK_RESAMPLE_MS = 30000;
  const CALIBRATION_TICKS = 3;
  const RESYNC_RETRY_MS = 2000;
  const CATCH_UP_GAP_MS = 250;
  const CATCH_UP_TRIES = 5;
  // Events that may be replayed when a player arrives during a level's opening sync, so the deal animation runs.
  const OPENING_EVENTS = ['levelStart', 'syncStart', 'handDown', 'allHandsDown'];

  const errorCode = (body) => (body && body.error && typeof body.error.code === 'string' ? body.error.code : 'INTERNAL');
  const parseTime = (x) => {
    if (x == null) return null;
    if (typeof x === 'number') return x;
    const t = Date.parse(x);
    return Number.isFinite(t) ? t : null;
  };
  const clone = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));

  class OnlineEngineProxy {
    constructor(o) {
      this.Mind = o.Mind;
      this.Sync = o.Sync;
      this.roomId = o.roomId;
      this.me = o.me;
      this.userId = o.userId;
      this.transport = o.transport;
      this.now = o.now || (() => globalThis.performance.now());
      this.schedule = o.schedule || ((fn, ms) => setTimeout(fn, ms));
      this.cancel = o.cancel || ((id) => clearTimeout(id));
      this.random = o.random || Math.random;
      this.log = o.log || console;
      this.flushMs = o.flushMs != null ? o.flushMs : FLUSH_MS;
      this.handWaitMs = o.handWaitMs != null ? o.handWaitMs : HAND_WAIT_MS;

      this.online = true;
      this.difficultyId = null;
      this.adapt = false;
      this.listeners = {};
      this.version = -1;
      this.status = null;
      this.ps = null;
      this.nextDeadlineAt = null;
      this.hostId = null;
      this.hand = [];
      this.handVersion = -1;
      this.model = null;
      this.pausedAt = null;
      this.wallNow = o.wallNow || (() => Date.now());
      this.appliedAt = {}; // version → wall-clock ms when this client applied it (for the e2e debug hook)

      this.clock = this.Sync.createClock();
      this.seq = this.Sync.createSequencer({
        onEvent: (ev) => this.deliver(ev),
        onGap: () => this.resync('gap'),
        schedule: this.schedule,
        cancel: this.cancel,
      });
      this.pendingState = null;
      this.pendingHand = null;
      this.incoming = [];
      this.flushTimer = null;
      this.batchStart = null;
      this.pendingByType = new Map(); // action type → requests on their way
      // Blind: the values of your own plays, so your card shows its face to you. By seq once the reply names it;
      // blindMark is the play still on its way (only one at a time).
      this.ownBlind = new Map();
      this.blindMark = null;
      this.tickKey = null;
      this.deadlineTimer = null;
      this.lastSampleAt = 0;
      this.timers = new Set();
      this.resyncing = false;
      this.resyncAgain = false;
      this.syncWaiters = []; // resolved by the next snapshot that starts after they were added and succeeds
      this.catchingUp = false;
      this.catchUpAgain = false;
      this.lastCatchUp = -Infinity;
      this.catchUpTimer = null;
      this.announced = -1; // the newest version the database has announced (Broadcast `version`)
      this.catchUpMisses = 0;
      this.disposed = false;
    }

    /* ---------- the read interface of MindEngine ---------- */
    get phase() { return this.model ? this.model.phase : 'idle'; }
    get level() { return this.model ? this.model.level : 0; }
    get maxLevel() { return this.model ? this.model.maxLevel : 0; }
    get lives() { return this.model ? this.model.lives : 0; }
    get stars() { return this.model ? this.model.stars : 0; }
    get variantId() { return this.model ? this.model.variantId : 'classic'; }
    get blind() { return this.model ? this.model.blind : false; }
    get revealed() { return this.model ? this.model.revealed : false; }
    get syncReason() { return this.model ? this.model.syncReason : null; }
    get pausedBy() { return this.model ? this.model.pausedBy : null; }
    get pausedFrom() { return this.model ? this.model.pausedFrom : null; }
    get piles() { return this.model ? this.model.piles : []; }
    get discard() { return this.model ? this.model.discard : []; }
    get lastPlay() { return this.model ? this.model.lastPlay : null; }
    get vote() { return this.model ? this.model.vote : null; }
    get allDownAt() { return this.model ? this.model.allDownAt : null; }
    get resolveUntil() { return this.model ? this.model.resolveUntil : null; }
    get stats() { return this.model ? this.model.stats : {}; }
    get players() { return this.model ? this.model.players : []; }
    get result() { return this.model ? this.model.result : null; }
    get human() { return this.players.find((p) => p.human) || null; }
    get isHost() { return this.hostId != null && this.hostId === this.userId; }

    player(id) { return this.players.find((p) => p.id === id); }
    pile(id) { return this.piles.find((p) => p.id === id); }
    // The engine's own helpers, so no rule is copied (I4).
    urgent(player, pileId) { return this.Mind.MindEngine.prototype.urgent.call(this, player, pileId); }
    rewardFor(level) { return this.Mind.MindEngine.prototype.rewardFor.call(this, level); }
    tension() { return 0; }
    nextDeadline() { return this.nextDeadlineAt; }

    serverNow(local) {
      const t = local != null ? local : this.now();
      return this.clock.ready ? this.clock.serverNow(t) : Date.now();
    }
    toLocal(serverMs) {
      if (serverMs == null) return null;
      return this.clock.ready ? this.clock.toLocal(serverMs) : serverMs - (Date.now() - this.now());
    }
    canEndGame(local) { return this.Sync.canEndGame(this.phase, this.pausedAt, this.serverNow(local)); }

    /** For e2e tests (MIND-05's dev override only): never contains a hand. */
    debug() {
      const ps = clone(this.ps);
      if (ps) delete ps.hand;
      return { version: this.version, publicState: ps, seq: this.seq.lastSeq, status: this.status, appliedAt: Object.assign({}, this.appliedAt) };
    }

    /* ---------- events ---------- */
    on(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
      return this;
    }
    safely(fn) {
      try {
        fn();
      } catch (err) {
        this.log.error('online table:', err);
      }
    }
    // Game events, exactly like MindEngine.emit.
    emit(type, data) {
      for (const fn of (this.listeners[type] || []).slice()) this.safely(() => fn(data || {}, this));
      for (const fn of (this.listeners['*'] || []).slice()) this.safely(() => fn(type, data || {}, this));
    }
    // Proxy signals for the table glue: refresh, status, actionDone, netError, resynced. Not sent to '*'.
    signal(type, data) {
      for (const fn of (this.listeners[type] || []).slice()) this.safely(() => fn(data || {}, this));
    }

    later(ms, fn) {
      const id = this.schedule(() => {
        this.timers.delete(id);
        if (!this.disposed) fn();
      }, ms);
      this.timers.add(id);
      return id;
    }

    /* ---------- incoming data ---------- */
    rebuild() {
      this.model = this.ps
        ? this.Sync.mapState(this.ps, this.hand, this.me, {
          toLocal: (x) => this.toLocal(x),
          syncHoldMs: this.Mind.TIMING.syncHold,
          variants: this.Mind.VARIANTS,
        })
        : null;
    }

    offerState(c) {
      if (!c || !Number.isInteger(c.version)) return;
      const best = this.pendingState ? this.pendingState.version : this.version;
      if (c.version < best) return;
      if (c.version === best) {
        // The same version from another source can add what the first one lacked: an INVALID_MOVE reply has no
        // status, a Realtime row has no hand.
        this.mergeSame(this.pendingState && this.pendingState.version === c.version ? this.pendingState : null, c);
        return;
      }
      this.pendingState = c;
      this.kick();
    }

    mergeSame(pending, c) {
      if (pending) {
        for (const k of ['status', 'hostId', 'nextDeadlineAt']) if (pending[k] === undefined && c[k] !== undefined) pending[k] = c[k];
        return;
      }
      let changed = false;
      if (c.status && c.status !== this.status) { this.status = c.status; changed = true; }
      if (c.hostId && c.hostId !== this.hostId) this.hostId = c.hostId;
      if (c.nextDeadlineAt !== undefined && c.nextDeadlineAt !== this.nextDeadlineAt) { this.nextDeadlineAt = c.nextDeadlineAt; this.armDeadline(); }
      if (changed) this.signal('status', { status: this.status, previous: null });
    }

    offerHand(h) {
      if (!h || !Array.isArray(h.hand) || !Number.isInteger(h.version)) return;
      const best = this.pendingHand ? this.pendingHand.version : this.handVersion;
      if (h.version < best) return;
      this.pendingHand = h;
      this.kick();
    }

    offerEvent(ev) {
      if (!ev || !Number.isInteger(ev.seq)) return;
      this.incoming.push(ev);
      this.kick();
    }

    kick() {
      if (this.disposed) return;
      if (this.batchStart == null) this.batchStart = this.now();
      if (this.flushTimer == null) this.flushTimer = this.schedule(() => this.flush(false), this.flushMs);
    }

    // Your hand row and the public hand count disagree while one of them is still on its way.
    handMismatch(st, hd) {
      const ps = st ? st.ps : this.ps;
      if (!ps || !Array.isArray(ps.players)) return false;
      const mine = ps.players.find((p) => p.id === this.me);
      const hand = hd ? hd.hand : this.hand;
      return !!mine && mine.handCount !== hand.length;
    }

    /**
     * Applies the newest state and hand, then emits the waiting events in seq order. Messages of one commit arrive
     * within a few ms of each other, so a short delay groups them. When the state changed but no event explains it
     * (e.g. after a gap), 'refresh' asks the UI to redraw from the state.
     */
    flush(force) {
      if (this.flushTimer != null) this.cancel(this.flushTimer);
      this.flushTimer = null;
      if (this.disposed) return;
      const st = this.pendingState && this.pendingState.version > this.version ? this.pendingState : null;
      const hd = this.pendingHand && this.pendingHand.version >= this.handVersion ? this.pendingHand : null;
      if (!force && this.handMismatch(st, hd) && this.batchStart != null && this.now() - this.batchStart < this.handWaitMs) {
        this.flushTimer = this.schedule(() => this.flush(false), 50);
        return;
      }
      this.pendingState = null;
      this.pendingHand = null;
      this.batchStart = null;

      const prevStatus = this.status;
      let changed = false;
      if (st) {
        if (st.ps != null || st.status === 'lobby') {
          this.version = st.version;
          this.ps = st.ps;
        } else if (st.status === 'playing') {
          // A row without its public_state (Realtime may leave out a large value): keep the version, so the snapshot
          // of that same version is still taken.
          this.later(0, () => this.resync('row-without-state'));
        } else {
          this.version = st.version;
        }
        if (st.status) this.status = st.status;
        if (st.nextDeadlineAt !== undefined) this.nextDeadlineAt = st.nextDeadlineAt;
        if (st.hostId) this.hostId = st.hostId;
        changed = true;
      }
      if (hd) {
        const same = JSON.stringify(hd.hand) === JSON.stringify(this.hand);
        this.hand = hd.hand.map((c) => ({ v: c.v, pile: c.pile }));
        this.handVersion = hd.version;
        if (!same) changed = true;
      }
      if (changed) this.rebuild();
      if (st && this.appliedAt[this.version] == null) {
        this.appliedAt[this.version] = this.wallNow();
        const keys = Object.keys(this.appliedAt);
        if (keys.length > 100) delete this.appliedAt[keys[0]];
      }

      const events = this.incoming;
      this.incoming = [];
      let delivered = 0;
      for (const ev of events) delivered += this.seq.push(ev);
      if (changed && delivered === 0 && this.seq.started) this.signal('refresh');
      if (changed) this.armDeadline();
      if (this.status !== prevStatus) this.signal('status', { status: this.status, previous: prevStatus });
    }

    /**
     * A timer for the next deadline, so ticks do not depend on animation frames, which browsers slow down under load
     * and stop in background tabs. tick() decides whether it is really due and adds the jitter.
     */
    armDeadline() {
      if (this.deadlineTimer != null) this.cancel(this.deadlineTimer);
      this.deadlineTimer = null;
      if (this.disposed || this.status !== 'playing' || this.nextDeadlineAt == null) return;
      const wait = Math.max(0, this.toLocal(this.nextDeadlineAt) - this.now());
      this.deadlineTimer = this.schedule(() => {
        this.deadlineTimer = null;
        if (this.disposed) return;
        this.tick(this.now());
        // Not due yet by the server clock estimate: look again shortly.
        if (this.tickKey !== this.version + ':' + this.nextDeadlineAt) this.deadlineTimer = this.schedule(() => this.armDeadline(), 50);
      }, wait);
    }

    // Called by the sequencer, in seq order.
    deliver(ev) {
      const data = ev.data || {};
      if (ev.type === 'paused') this.pausedAt = ev.at != null ? ev.at : this.serverNow();
      if (ev.type === 'resumed') this.pausedAt = null;
      // A Blind play hides the card from everybody, you included; your own card is yours to see (I2).
      if (ev.type === 'play' && data.playerId === this.me && data.card && data.card.v == null) {
        if (this.ownBlind.has(ev.seq)) data.card.v = this.ownBlind.get(ev.seq);
        else if (this.blindMark && !this.blindMark.used) {
          // The event came before the reply (e.g. a catch-up): it can only be the play on its way.
          this.blindMark.used = true;
          data.card.v = this.blindMark.v;
        }
      }
      for (const seq of this.ownBlind.keys()) if (seq <= ev.seq) this.ownBlind.delete(seq);
      this.emit(ev.type, data);
    }

    ingestRoomRow(row) {
      if (!row || row.id !== this.roomId) return;
      this.offerState({
        version: row.version,
        ps: row.public_state,
        status: row.status,
        nextDeadlineAt: parseTime(row.next_deadline_at),
        hostId: row.host_id,
      });
    }

    ingestHandRow(row) {
      if (!row || row.room_id !== this.roomId || (this.userId && row.user_id !== this.userId)) return;
      this.offerHand({ hand: row.hand, version: row.version });
    }

    ingestEventRow(row) {
      if (!row || row.room_id !== this.roomId) return;
      this.offerEvent({ seq: row.seq, type: row.type, data: row.payload, at: parseTime(row.created_at) });
    }

    // The reply of a room-action call: { status, body, sentAt, receivedAt } (local times around the request).
    ingestResponse(res) {
      const b = (res && res.body) || {};
      if (Number.isFinite(b.serverNow) && this.clock.sample(res.sentAt, res.receivedAt, b.serverNow)) {
        if (this.ps) this.rebuild();
        if (this.seq.started) this.armDeadline();
      }
      if (Number.isFinite(b.serverNow)) this.lastSampleAt = res.receivedAt;
      if (Number.isInteger(b.version) && b.view !== undefined) {
        const st = { version: b.version, ps: this.Sync.publicPart(b.view), nextDeadlineAt: b.nextDeadlineAt != null ? b.nextDeadlineAt : null };
        if (b.status) st.status = b.status;
        this.offerState(st);
        if (b.view && Array.isArray(b.view.hand)) this.offerHand({ hand: b.view.hand, version: b.version });
      }
      if (Array.isArray(b.events)) {
        for (const e of b.events) this.offerEvent({ seq: e.seq, type: e.type, data: e.data, at: b.serverNow });
      }
    }

    /* ---------- snapshots ---------- */
    applySnapshot(snap) {
      const r = snap.room;
      if (r.host_id) this.hostId = r.host_id;
      if (snap.pausedAt != null) this.pausedAt = snap.pausedAt;
      this.offerState({ version: r.version, ps: r.public_state, status: r.status, nextDeadlineAt: parseTime(r.next_deadline_at), hostId: r.host_id });
      if (snap.hand) this.offerHand({ hand: snap.hand.hand, version: snap.hand.version });
      this.flush(true);
    }

    async calibrate() {
      for (let i = 0; i < CALIBRATION_TICKS && !this.disposed; i++) {
        await this.send('tick');
        if (i < CALIBRATION_TICKS - 1) await new Promise((r) => this.later(120, r));
      }
    }

    /** First load: the snapshot and the clock. Events wait in the sequencer until begin(). → the snapshot */
    async prepare() {
      const [snap] = await Promise.all([this.transport.snapshot(), this.calibrate()]);
      if (!snap || !snap.room) {
        const err = new Error('ROOM_NOT_FOUND');
        err.code = 'ROOM_NOT_FOUND';
        throw err;
      }
      this.applySnapshot(snap);
      this.entryEvents = (snap.events || []).slice().sort((a, b) => a.seq - b.seq);
      return snap;
    }

    /**
     * Starts emitting events, once the UI listens. Arriving during a level's opening sync replays that level's
     * events, so everybody sees the deal; otherwise the UI is redrawn from the state.
     */
    begin() {
      this.armDeadline();
      const events = this.entryEvents || [];
      this.entryEvents = null;
      const lastSeq = events.length ? events[events.length - 1].seq : 0;
      let from = -1;
      if (this.phase === 'sync' && this.syncReason === 'level') {
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i].type === 'levelStart') {
            if ((events[i].data || {}).level === this.level && events.slice(i + 1).every((e) => OPENING_EVENTS.includes(e.type))) from = i;
            break;
          }
        }
      }
      if (from >= 0) {
        this.seq.reset(events[from].seq - 1);
        for (const e of events.slice(from)) this.seq.push(e);
        this.seq.reset(lastSeq);
      } else {
        this.signal('refresh');
        this.seq.reset(lastSeq);
      }
    }

    /** Fresh snapshot after a gap, a reconnect or a tab coming back. Events after it continue in order. */
    async resync(reason) {
      if (this.disposed) return;
      if (this.resyncing) {
        this.resyncAgain = true;
        return;
      }
      this.resyncing = true;
      const served = this.syncWaiters;
      this.syncWaiters = [];
      let done = false;
      try {
        const snap = await this.transport.snapshot();
        if (this.disposed) return;
        if (!snap || !snap.room) {
          done = true;
          this.signal('status', { status: 'gone', previous: this.status });
          return;
        }
        this.applySnapshot(snap);
        this.signal('refresh');
        const events = snap.events || [];
        const lastSeq = events.reduce((m, e) => Math.max(m, e.seq), 0);
        this.seq.reset(Math.max(lastSeq, this.seq.lastSeq));
        done = true;
        this.signal('resynced', { reason });
      } catch (err) {
        if (this.disposed) return;
        this.signal('netError', { code: (err && err.code) || 'NETWORK' });
        this.later(RESYNC_RETRY_MS, () => this.resync('retry'));
      } finally {
        if (done) served.forEach((f) => f());
        else this.syncWaiters = served.concat(this.syncWaiters);
        this.resyncing = false;
        if (this.resyncAgain && !this.disposed) {
          this.resyncAgain = false;
          this.resync('again');
        }
      }
    }

    /**
     * The database says (Broadcast `version`) that the room is at version `v`. Realtime's Postgres Changes can take a
     * second or more after a quiet spell, so a newer version is fetched at once: the state, then the events after the
     * last seq, which play in order as usual. Catch-ups are spaced CATCH_UP_GAP_MS apart; Postgres Changes still
     * arrive later and are dropped as duplicates.
     */
    noteVersion(v) {
      if (this.disposed || !this.seq.started || !Number.isInteger(v)) return;
      if (v > this.announced) this.announced = v;
      if (this.behindAnnounced()) {
        this.catchUpMisses = 0;
        this.catchUp();
      }
    }

    behindAnnounced() {
      const known = this.pendingState ? Math.max(this.version, this.pendingState.version) : this.version;
      return this.announced > known;
    }

    async catchUp() {
      if (this.disposed || !this.transport.since) return;
      if (this.catchingUp) {
        this.catchUpAgain = true;
        return;
      }
      const wait = this.lastCatchUp + CATCH_UP_GAP_MS - this.now();
      if (wait > 0) {
        if (this.catchUpTimer == null) this.catchUpTimer = this.later(wait, () => { this.catchUpTimer = null; this.catchUp(); });
        return;
      }
      this.catchingUp = true;
      this.lastCatchUp = this.now();
      // Every event up to this announced version is visible by the time its broadcast arrives.
      const covered = this.announced;
      let eventsMayLag = false;
      try {
        const snap = await this.transport.since(this.seq.lastSeq);
        if (!this.disposed && snap && snap.room) {
          const r = snap.room;
          // The state was read after the events: a newer commit may have landed in between, whose events come next.
          eventsMayLag = r.version > covered;
          this.offerState({ version: r.version, ps: r.public_state, status: r.status, nextDeadlineAt: parseTime(r.next_deadline_at), hostId: r.host_id });
          if (snap.hand) this.offerHand({ hand: snap.hand.hand, version: snap.hand.version });
          for (const e of snap.events || []) this.offerEvent(e);
        }
      } catch (err) { /* Realtime still delivers; the next hint tries again */ }
      this.catchingUp = false;
      if (this.disposed) return;
      // A read that failed or was a little behind (a busy server) is tried again while the announced version is
      // still missing, a few times; after that the 1 s gap snapshot and Postgres Changes still bring it.
      const missed = this.behindAnnounced() || eventsMayLag;
      if (missed) this.catchUpMisses++;
      if (this.catchUpAgain || (missed && this.catchUpMisses < CATCH_UP_TRIES)) {
        this.catchUpAgain = false;
        this.catchUp();
      }
    }

    /* ---------- actions ---------- */
    inflight(type) { return (this.pendingByType.get(type) || 0) > 0; }

    // parallel: allow this request while another of the same type is still on its way (only for idempotent ticks).
    async send(type, input, parallel) {
      if (this.disposed || (!parallel && this.inflight(type))) return { ok: false, code: 'BUSY' };
      this.pendingByType.set(type, (this.pendingByType.get(type) || 0) + 1);
      const release = () => this.pendingByType.set(type, this.pendingByType.get(type) - 1);
      let res = null;
      let code = null;
      try {
        res = await this.transport.action(type, input || {});
      } catch (err) {
        code = (err && err.code) || 'NETWORK';
      }
      if (this.disposed) return { ok: false, code: 'DISPOSED' };
      if (res) {
        if (type === 'play') this.noteOwnBlindPlay(res.body);
        this.ingestResponse(res);
        // The reply's state goes in before the action is free again: until then your hand still holds the card
        // just played, and a second `play` would play your next card.
        this.flush(true);
        code = res.status === 200 ? null : errorCode(res.body);
      }
      const ok = code == null;
      const unknown = code === 'NETWORK' || code === 'INTERNAL';
      if (unknown && type !== 'tick') {
        // The action may have been applied without us hearing back: it stays blocked until a fresh snapshot says
        // where the table is.
        this.afterFreshSnapshot('action-failed').then(release);
      } else {
        release();
      }
      if (!ok) {
        // INVALID_MOVE carries the current state, which was just applied: a quiet resync, no toast.
        if (code === 'CONFLICT_RETRY') this.resync('conflict');
        else if (unknown && type === 'tick') this.later(1000, () => this.resync('action-failed'));
        if (type !== 'tick') this.signal('refresh');
      }
      if (type !== 'tick') this.signal('actionDone', { type, ok, code });
      return { ok, code };
    }

    /** Resolves once a snapshot taken after this call has been applied (retrying until one succeeds). */
    afterFreshSnapshot(reason) {
      return new Promise((resolve) => {
        this.syncWaiters.push(resolve);
        this.resync(reason);
      });
    }

    // The reply to your Blind play names its seq: remember your card's value under it.
    noteOwnBlindPlay(body) {
      const mark = this.blindMark;
      if (!mark || mark.used || !body || !Array.isArray(body.events)) return;
      const ev = body.events.find((e) => e.type === 'play' && e.data && e.data.playerId === this.me);
      if (!ev) return;
      mark.used = true;
      if (ev.seq > this.seq.lastSeq) this.ownBlind.set(ev.seq, mark.v);
    }

    // Sends an action unless the same one is still on its way. → true when sent (the UI then shows it pressed).
    request(type, input) {
      if (this.disposed || this.inflight(type)) return false;
      this.send(type, input);
      return true;
    }

    placeHand() {
      const h = this.human;
      if (this.phase !== 'sync' || !h || h.handDown) return false;
      return this.request('handDown');
    }

    humanPlay(pileId) {
      const h = this.human;
      if (this.phase !== 'playing' || !h || !h.hand.length || this.inflight('play')) return false;
      if (pileId != null && (!this.pile(pileId) || !this.urgent(h, pileId))) return false;
      const card = pileId != null ? this.urgent(h, pileId) : this.piles.map((p) => this.urgent(h, p.id)).find(Boolean);
      const mark = this.blind && card ? { v: card.v, used: false } : null;
      this.blindMark = mark;
      this.send('play', pileId != null ? { pileId } : {}).then(() => {
        if (this.blindMark === mark) this.blindMark = null;
      });
      return true;
    }

    playCard(playerId, pileId) { return this.humanPlay(pileId); }

    proposeStar() {
      if (this.phase !== 'playing' || this.stars <= 0) return false;
      return this.request('proposeStar');
    }

    // voteStar(agree, now) like the offline engine, or voteStar(playerId, agree, now).
    voteStar(a, b) {
      const agree = typeof a === 'boolean' ? a : b;
      if (typeof agree !== 'boolean' || this.phase !== 'starVote' || !this.vote || this.vote.votes[this.me] !== undefined) return false;
      return this.request('voteStar', { agree });
    }

    callRefocus() {
      if (this.phase !== 'playing' || this.blind) return false;
      return this.request('refocus');
    }

    pause() {
      if (this.status !== 'playing' || ['idle', 'paused', 'levelComplete', 'victory', 'gameOver'].includes(this.phase)) return false;
      return this.request('pause');
    }

    resume() {
      if (this.phase !== 'paused') return false;
      return this.request('resume');
    }

    nextLevel() {
      if (this.phase !== 'levelComplete') return false;
      return this.request('nextLevel');
    }

    endGame() {
      if (this.phase !== 'paused') return false;
      return this.request('endGame');
    }

    // Host only; the server checks that the game is over.
    rematch() {
      if (!this.isHost) return false;
      return this.request('rematch');
    }

    /**
     * Called every frame with the local time. When the server clock passes nextDeadlineAt, sends `tick` after a
     * random 0–150 ms; if the state has not changed 1 s later, ticks once more. Also refreshes the clock now and then.
     */
    tick(localNow) {
      if (this.disposed || this.status !== 'playing' || !this.seq.started) return;
      const t = localNow != null ? localNow : this.now();
      if (this.clock.ready && t - this.lastSampleAt > CLOCK_RESAMPLE_MS && !this.inflight('tick')) {
        this.lastSampleAt = t;
        this.send('tick');
        return;
      }
      const deadline = this.nextDeadlineAt;
      if (!this.Sync.isDue(deadline, this.serverNow(t))) return;
      const key = this.version + ':' + deadline;
      if (this.tickKey === key) return;
      this.tickKey = key;
      const version = this.version;
      const still = () => !this.disposed && this.version === version && this.tickKey === key;
      this.later(this.random() * TICK_JITTER_MS, () => {
        if (!still()) return;
        this.send('tick', {}, true);
        // Ticks are idempotent, so the retry goes out even if the first one is still hanging (e.g. on a server
        // worker that is being replaced).
        this.later(TICK_RETRY_MS, () => { if (still()) this.send('tick', {}, true); });
        // Safety net: if nobody's tick got through, allow another round (tick + one retry).
        this.later(TICK_ROUND_MS, () => {
          if (!still()) return;
          this.tickKey = null;
          this.armDeadline();
        });
      });
    }

    dispose() {
      this.disposed = true;
      for (const f of this.syncWaiters.splice(0)) f();
      if (this.flushTimer != null) this.cancel(this.flushTimer);
      if (this.deadlineTimer != null) this.cancel(this.deadlineTimer);
      this.deadlineTimer = null;
      for (const id of this.timers) this.cancel(id);
      this.timers.clear();
      this.seq.dispose();
      this.listeners = {};
    }
  }

  function create(opts) {
    return new OnlineEngineProxy(opts);
  }

  return { create, OnlineEngineProxy, FLUSH_MS, HAND_WAIT_MS, TICK_JITTER_MS, TICK_RETRY_MS, CLOCK_RESAMPLE_MS };
});
