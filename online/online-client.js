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

  async function callFunction(name, body) {
    const { cfg } = await getClient();
    let session = await ensureSession();
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await global.fetch(cfg.supabaseUrl + '/functions/v1/' + name, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + session.access_token, apikey: cfg.supabaseKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (e) {
        throw onlineError('NETWORK');
      }
      let json = null;
      try {
        json = await res.json();
      } catch (e) { /* not JSON: a gateway or proxy error */ }
      if (res.ok && json) return json;
      const err = res.ok ? { code: 'INTERNAL' } : Core.errorFromResponse(res.status, json);
      if (err.code === 'UNAUTHORIZED' && attempt === 0) {
        session = await renewSession();
        continue;
      }
      if (res.status >= 502 && res.status <= 504) throw onlineError('NETWORK');
      throw onlineError(err.code, err.roomId ? { roomId: err.roomId } : undefined);
    }
  }

  /** Lobby actions of the `rooms` function: create, join, leave, setVariant. */
  const rooms = (action, input) => callFunction('rooms', Object.assign({ action }, input));

  /** Gameplay actions of the `room-action` function (the lobby only uses `start`). */
  const roomAction = (roomId, type, input) => callFunction('room-action', Object.assign({ roomId, type }, input));

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
   * Joins the room's private channel `room:<roomId>`: Postgres Changes on the room and its seats, and Presence keyed
   * on the user id. handlers: onChange() (re-read the room), onPresence(state), onStatus('live' | 'down').
   * → { unsubscribe() }
   */
  async function subscribeRoom(roomId, userId, handlers) {
    const { client: c } = await getClient();
    await c.realtime.setAuth();
    const channel = c.channel('room:' + roomId, { config: { private: true, presence: { key: userId } } });
    const changed = () => handlers.onChange();
    // A lobby leave deletes the seat and also bumps rooms.version, so the rooms UPDATE covers it. DELETE events are
    // not subscribed: Realtime cannot filter them or check them against RLS.
    channel
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: 'id=eq.' + roomId }, changed)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_players', filter: 'room_id=eq.' + roomId }, changed)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'room_players', filter: 'room_id=eq.' + roomId }, changed)
      .on('presence', { event: 'sync' }, () => handlers.onPresence(channel.presenceState()))
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          channel.track({ online_at: new Date().toISOString() }).catch(() => {});
          handlers.onStatus('live');
          handlers.onChange();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          handlers.onStatus('down');
        }
      });
    let closed = false;
    return {
      unsubscribe() {
        if (closed) return;
        closed = true;
        c.removeChannel(channel);
      },
    };
  }

  global.MindOnlineClient = {
    SUPABASE_JS, DEV_CONFIG_KEY,
    config, configured, loadSdk, currentSession, ensureSession, rooms, roomAction, fetchRoom, subscribeRoom, toError,
  };
})(window);
