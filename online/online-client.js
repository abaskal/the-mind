/* Online client (MIND-05): Supabase config, the lazily loaded supabase-js, anonymous sign-in, calls to the `rooms` and
 * `room-action` Edge Functions, room reads (RLS: members only) and the room's private Realtime channel.
 * Nothing here touches the network until online mode asks for it (I5). Every write goes through an Edge Function (I3),
 * and the browser only ever holds the project URL and the publishable key (I8). Sets window.MindOnlineClient. */
(function (global) {
  'use strict';

  const Core = global.MindOnlineCore;
  const DEV_CONFIG_KEY = 'theMind.online.dev';

  // Pinned exact version, checked by Subresource Integrity. To upgrade, change both (see docs/online/BACKEND.md).
  const SUPABASE_JS = Object.freeze({
    version: '2.118.0',
    src: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js',
    integrity: 'sha384-TcHRA3zBbn+Lexh5n+Oil4guNPOS3rjNDpGRAN46u/s/mB2IZ50ceC6TYDU2yvgK',
  });

  let sdkPromise = null;
  let client = null;
  let clientKey = '';

  function onlineError(code, extra) {
    const err = new Error(code);
    err.name = 'OnlineError';
    err.code = code;
    return Object.assign(err, extra);
  }

  /** An error as { code, roomId? }: OnlineErrors keep their code, anything unexpected counts as unreachable. */
  function toError(err) {
    if (err && err.name === 'OnlineError') return { code: err.code, roomId: err.roomId };
    return { code: 'NETWORK' };
  }

  /** { supabaseUrl, supabaseKey } or null when online play is not set up. */
  function config() {
    let dev = null;
    try {
      dev = global.localStorage.getItem(DEV_CONFIG_KEY);
    } catch (e) { /* storage may be unavailable (private mode) */ }
    return Core.resolveConfig(global.MIND_ONLINE, dev);
  }

  const configured = () => config() != null;

  function loadSdk() {
    if (global.supabase && typeof global.supabase.createClient === 'function') return Promise.resolve(global.supabase);
    if (!sdkPromise) {
      sdkPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = SUPABASE_JS.src;
        s.integrity = SUPABASE_JS.integrity;
        s.crossOrigin = 'anonymous';
        s.referrerPolicy = 'no-referrer';
        s.async = true;
        s.onload = () => {
          if (global.supabase && typeof global.supabase.createClient === 'function') resolve(global.supabase);
          else reject(onlineError('NETWORK'));
        };
        s.onerror = () => {
          s.remove();
          reject(onlineError('NETWORK'));
        };
        document.head.appendChild(s);
      }).catch((err) => {
        sdkPromise = null;
        throw err;
      });
    }
    return sdkPromise;
  }

  async function getClient() {
    const cfg = config();
    if (!cfg) throw onlineError('NOT_CONFIGURED');
    const key = cfg.supabaseUrl + ' ' + cfg.supabaseKey;
    if (client && clientKey === key) return { client, cfg };
    const sdk = await loadSdk();
    // supabase-js keeps the session in localStorage, so a reload keeps the same anonymous user (and seat).
    client = sdk.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    clientKey = key;
    return { client, cfg };
  }

  /** The stored session, or null. Never signs in. */
  async function currentSession() {
    const { client: c } = await getClient();
    const { data, error } = await c.auth.getSession();
    if (error) return null;
    return (data && data.session) || null;
  }

  /** The stored session, or a new anonymous one on the first online visit. Concurrent callers share one sign-in. */
  let signingIn = null;
  async function ensureSession() {
    const existing = await currentSession();
    if (existing) return existing;
    if (!signingIn) {
      signingIn = (async () => {
        const { client: c } = await getClient();
        let result;
        try {
          result = await c.auth.signInAnonymously();
        } catch (e) {
          throw onlineError('NETWORK');
        }
        if (result.error || !result.data || !result.data.session) throw onlineError(Core.authErrorCode(result.error));
        return result.data.session;
      })().finally(() => { signingIn = null; });
    }
    return signingIn;
  }

  // A 401 means the access token was refused: refresh it once; if the refresh token is dead too, start a new session.
  async function renewSession() {
    const { client: c } = await getClient();
    const refreshed = await c.auth.refreshSession().catch(() => ({ error: true }));
    if (!refreshed.error && refreshed.data && refreshed.data.session) return refreshed.data.session;
    await c.auth.signOut({ scope: 'local' }).catch(() => {});
    return ensureSession();
  }

  // One Edge Function call, after one token refresh on 401. → { res, json, sentAt, receivedAt } (local times).
  async function request(name, body) {
    const { cfg } = await getClient();
    let session = await ensureSession();
    for (let attempt = 0; ; attempt++) {
      let res;
      let json = null;
      const sentAt = global.performance.now();
      try {
        res = await global.fetch(cfg.supabaseUrl + '/functions/v1/' + name, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + session.access_token, apikey: cfg.supabaseKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        json = await res.json().catch(() => null);
      } catch (e) {
        throw onlineError('NETWORK');
      }
      const receivedAt = global.performance.now();
      if (res.status === 401 && attempt === 0) {
        session = await renewSession();
        continue;
      }
      if (res.status >= 502 && res.status <= 504) throw onlineError('NETWORK');
      return { res, json, sentAt, receivedAt };
    }
  }

  async function callFunction(name, body) {
    const { res, json } = await request(name, body);
    if (res.ok && json) return json;
    const err = res.ok ? { code: 'INTERNAL' } : Core.errorFromResponse(res.status, json);
    throw onlineError(err.code, err.roomId ? { roomId: err.roomId } : undefined);
  }

  /** Lobby actions of the `rooms` function: create, join, leave, setVariant. */
  const rooms = (action, input) => callFunction('rooms', Object.assign({ action }, input));

  /** Gameplay actions of the `room-action` function (the lobby only uses `start`). */
  const roomAction = (roomId, type, input) => callFunction('room-action', Object.assign({ roomId, type }, input));

  /**
   * A room-action call for the online table: never throws on 4xx, because INVALID_MOVE carries the current state.
   * → { status, body, sentAt, receivedAt } (local performance.now() times, for the clock estimate). Throws NETWORK.
   */
  async function roomActionRaw(roomId, type, input) {
    const { res, json, sentAt, receivedAt } = await request('room-action', Object.assign({ roomId, type }, input));
    const body = json && typeof json === 'object' ? json : { error: { code: res.ok ? 'INTERNAL' : Core.errorFromResponse(res.status, json).code } };
    return { status: res.status, body, sentAt, receivedAt };
  }

  function readError(result) {
    if (!result.status) return onlineError('NETWORK');
    if (result.status === 401) return onlineError('UNAUTHORIZED');
    return onlineError('INTERNAL');
  }

  /**
   * The room and its seated players, read through RLS (members only). → { room, players } or null when the room is
   * gone or the caller is not seated in it any more.
   */
  async function fetchRoom(roomId) {
    if (!Core.isUuid(roomId)) return null;
    const { client: c } = await getClient();
    let r, p;
    try {
      [r, p] = await Promise.all([
        c.from('rooms').select('id, code, host_id, variant, status, version').eq('id', roomId).maybeSingle(),
        c.from('room_players').select('user_id, seat, nickname, joined_at, left_at').eq('room_id', roomId)
          .is('left_at', null).order('seat'),
      ]);
    } catch (e) {
      throw onlineError('NETWORK');
    }
    if (r.error) throw readError(r);
    if (p.error) throw readError(p);
    if (!r.data) return null;
    return { room: r.data, players: p.data || [] };
  }

  /**
   * Everything the online table needs to (re)draw itself, read through RLS: the room with its public_state, the
   * seated players, your own hand and the latest events (read after the state, so no event is replayed twice; a
   * newer state arrives over Realtime anyway). → null when the room is gone or you are not seated in it.
   */
  async function fetchTable(roomId, userId) {
    if (!Core.isUuid(roomId)) return null;
    const { client: c } = await getClient();
    try {
      const [r, p, h] = await Promise.all([
        c.from('rooms').select('id, code, host_id, variant, status, version, public_state, next_deadline_at').eq('id', roomId).maybeSingle(),
        c.from('room_players').select('user_id, seat, nickname, joined_at').eq('room_id', roomId).is('left_at', null).order('seat'),
        c.from('room_hands').select('hand, version').eq('room_id', roomId).eq('user_id', userId).maybeSingle(),
      ]);
      for (const x of [r, p, h]) if (x.error) throw readError(x);
      if (!r.data) return null;
      const e = await c.from('room_events').select('seq, type, payload, created_at').eq('room_id', roomId)
        .order('seq', { ascending: false }).limit(TABLE_EVENTS);
      if (e.error) throw readError(e);
      const events = (e.data || []).map((x) => ({ seq: x.seq, type: x.type, data: x.payload, at: Date.parse(x.created_at) }));
      let pausedAt = null;
      if (r.data.public_state && r.data.public_state.phase === 'paused') {
        let paused = events.find((x) => x.type === 'paused');
        if (!paused) {
          const q = await c.from('room_events').select('seq, created_at').eq('room_id', roomId).eq('type', 'paused')
            .order('seq', { ascending: false }).limit(1);
          if (!q.error && q.data && q.data[0]) paused = { at: Date.parse(q.data[0].created_at) };
        }
        if (paused && Number.isFinite(paused.at)) pausedAt = paused.at;
      }
      return { room: r.data, players: p.data || [], hand: h.data || null, events, pausedAt };
    } catch (err) {
      if (err && err.name === 'OnlineError') throw err;
      throw onlineError('NETWORK');
    }
  }

  /**
   * What changed after `afterSeq`, for a quick catch-up: the room with its public_state and your hand, then the events
   * after `afterSeq` in order (read after the state, so the state is never behind them). → null when the room is gone.
   */
  async function fetchSince(roomId, userId, afterSeq) {
    if (!Core.isUuid(roomId)) return null;
    const { client: c } = await getClient();
    try {
      const [r, h] = await Promise.all([
        c.from('rooms').select('id, code, host_id, variant, status, version, public_state, next_deadline_at').eq('id', roomId).maybeSingle(),
        c.from('room_hands').select('hand, version').eq('room_id', roomId).eq('user_id', userId).maybeSingle(),
      ]);
      for (const x of [r, h]) if (x.error) throw readError(x);
      if (!r.data) return null;
      const e = await c.from('room_events').select('seq, type, payload, created_at').eq('room_id', roomId)
        .gt('seq', Number(afterSeq) || 0).order('seq', { ascending: true }).limit(TABLE_EVENTS);
      if (e.error) throw readError(e);
      const events = (e.data || []).map((x) => ({ seq: x.seq, type: x.type, data: x.payload, at: Date.parse(x.created_at) }));
      return { room: r.data, hand: h.data || null, events };
    } catch (err) {
      if (err && err.name === 'OnlineError') throw err;
      throw onlineError('NETWORK');
    }
  }

  /*
   * One private channel per room, `room:<roomId>`, shared by the lobby and the table: supabase-js returns the same
   * channel object for the same topic, and bindings cannot be added once it is subscribed. So the channel carries
   * every binding either screen needs, and screens add and remove listeners. Presence stays connected when the lobby
   * hands over to the table. The channel closes CLOSE_DELAY_MS after its last listener leaves.
   * DELETE events are not subscribed: Realtime cannot filter them or check them against RLS. A lobby leave also bumps
   * rooms.version, so the rooms UPDATE covers it.
   */
  const CLOSE_DELAY_MS = 3000;
  const TABLE_EVENTS = 30;
  const channels = new Map();

  function closeEntry(entry) {
    clearTimeout(entry.closeTimer);
    const known = channels.get(entry.roomId);
    if (known && known.entry === entry) channels.delete(entry.roomId);
    entry.listeners.clear();
    entry.client.removeChannel(entry.channel);
  }

  async function createEntry(roomId, userId) {
    const { client: c } = await getClient();
    await c.realtime.setAuth();
    const entry = { roomId, userId, client: c, listeners: new Set(), status: 'connecting', presence: {}, closeTimer: null };
    const each = (fn) => {
      for (const l of Array.from(entry.listeners)) {
        try {
          fn(l);
        } catch (err) {
          global.console.error('room channel listener:', err);
        }
      }
    };
    const pg = (event, table, filter, fn) => entry.channel.on('postgres_changes', { event, schema: 'public', table, filter }, (p) => fn(p.new));
    entry.channel = c.channel('room:' + roomId, { config: { private: true, presence: { key: userId } } });
    const room = (row) => each((l) => { if (l.onRoom) l.onRoom(row); if (l.onChange) l.onChange(); });
    const seat = (row) => each((l) => { if (l.onPlayers) l.onPlayers(row); if (l.onChange) l.onChange(); });
    const hand = (row) => each((l) => { if (l.onHand) l.onHand(row); });
    pg('UPDATE', 'rooms', 'id=eq.' + roomId, room);
    pg('INSERT', 'room_players', 'room_id=eq.' + roomId, seat);
    pg('UPDATE', 'room_players', 'room_id=eq.' + roomId, seat);
    pg('INSERT', 'room_events', 'room_id=eq.' + roomId, (row) => each((l) => { if (l.onEvent) l.onEvent(row); }));
    pg('INSERT', 'room_hands', 'user_id=eq.' + userId, hand);
    pg('UPDATE', 'room_hands', 'user_id=eq.' + userId, hand);
    // {"v": version} from the database on every room change (migration 20261103100000): faster than Postgres Changes.
    entry.channel.on('broadcast', { event: 'version' }, (msg) => {
      const v = msg && msg.payload ? msg.payload.v : null;
      each((l) => { if (l.onVersion) l.onVersion(v); });
    });
    entry.channel
      .on('presence', { event: 'sync' }, () => {
        entry.presence = entry.channel.presenceState();
        each((l) => { if (l.onPresence) l.onPresence(entry.presence); });
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // Presence is tracked once per (re)join: Realtime allows a client only a few Presence updates per 30 s.
          entry.channel.track({ online_at: new Date().toISOString() }).catch(() => {});
          entry.status = 'live';
          each((l) => { if (l.onStatus) l.onStatus('live'); if (l.onChange) l.onChange(); });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          entry.status = 'down';
          each((l) => { if (l.onStatus) l.onStatus('down'); });
        }
      });
    return entry;
  }

  function channelFor(roomId, userId) {
    const known = channels.get(roomId);
    if (known && known.userId === userId) return known.promise;
    if (known) known.promise.then(closeEntry, () => {});
    const record = { userId, entry: null, promise: null };
    record.promise = createEntry(roomId, userId).then((entry) => {
      record.entry = entry;
      return entry;
    });
    record.promise.catch(() => { if (channels.get(roomId) === record) channels.delete(roomId); });
    channels.set(roomId, record);
    return record.promise;
  }

  /**
   * Listens on the room's private channel `room:<roomId>`. handlers (all optional):
   *   onChange()          the room or its seats changed (re-read them); also once the channel is live
   *   onRoom(row)         rooms UPDATE · onPlayers(row) room_players INSERT/UPDATE
   *   onEvent(row)        room_events INSERT · onHand(row) your room_hands INSERT/UPDATE
   *   onVersion(v)        Broadcast `version` from the database: the room is now at version v
   *   onPresence(state)   Presence keyed on the user id · onStatus('live' | 'down')
   * → { unsubscribe(), presenceState(), status }
   */
  async function subscribeRoom(roomId, userId, handlers) {
    const entry = await channelFor(roomId, userId);
    clearTimeout(entry.closeTimer);
    entry.closeTimer = null;
    entry.listeners.add(handlers);
    if (entry.status !== 'connecting') {
      // The channel is already up (e.g. the lobby handed over): bring this listener up to date.
      setTimeout(() => {
        if (!entry.listeners.has(handlers)) return;
        if (handlers.onStatus) handlers.onStatus(entry.status);
        if (entry.status === 'live') {
          if (handlers.onPresence) handlers.onPresence(entry.presence);
          if (handlers.onChange) handlers.onChange();
        }
      }, 0);
    }
    let closed = false;
    return {
      unsubscribe() {
        if (closed) return;
        closed = true;
        entry.listeners.delete(handlers);
        if (!entry.listeners.size) entry.closeTimer = setTimeout(() => closeEntry(entry), CLOSE_DELAY_MS);
      },
      presenceState: () => entry.presence,
      get status() { return entry.status; },
    };
  }

  /** Whether the local-development override (theMind.online.dev) is set: e2e tests then get a debug hook. */
  function devOverride() {
    try {
      return Core.resolveConfig(null, global.localStorage.getItem(DEV_CONFIG_KEY)) != null;
    } catch (e) {
      return false;
    }
  }

  global.MindOnlineClient = {
    SUPABASE_JS, DEV_CONFIG_KEY,
    config, configured, devOverride, loadSdk, currentSession, ensureSession, rooms, roomAction, roomActionRaw, fetchRoom,
    fetchTable, fetchSince, subscribeRoom, toError,
  };
})(window);
