/* Pure helpers for online play (MIND-05): room codes, the ?room= share link, config and key checks, error → i18n
 * keys, seats + presence. No DOM and no network, so Node tests require() this file; the browser loads it as a
 * classic script that sets window.MindOnlineCore. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MindOnlineCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Same alphabet and pattern as supabase/functions/_shared/rooms-rules.mjs: no I, O, 0 or 1.
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
  const CODE_LENGTH = 6;
  const MAX_SEATS = 4;
  const MIN_PLAYERS = 2;
  const NICKNAME_MAX_LENGTH = 16;
  const ACTIVE_STATUSES = ['lobby', 'playing'];
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const ERROR_KEYS = {
    INVALID_INPUT: 'online.err.invalidInput',
    INVALID_NICKNAME: 'online.err.nickname',
    INVALID_CODE: 'online.err.code',
    UNAUTHORIZED: 'online.err.auth',
    NOT_HOST: 'online.err.notHost',
    ROOM_NOT_FOUND: 'online.err.notFound',
    NICKNAME_TAKEN: 'online.err.nicknameTaken',
    ROOM_FULL: 'online.err.full',
    GAME_IN_PROGRESS: 'online.err.started',
    ALREADY_IN_GAME: 'online.err.inGame',
    RATE_LIMITED: 'online.err.rateLimited',
    NOT_A_MEMBER: 'online.err.notMember',
    INVALID_MOVE: 'online.err.invalidMove',
    CONFLICT_RETRY: 'online.err.busy',
    NOT_CONFIGURED: 'online.home.off',
    NETWORK: 'online.err.network',
    INTERNAL: 'online.err.internal',
  };
  const RETRYABLE = ['NETWORK', 'INTERNAL', 'CONFLICT_RETRY', 'UNAUTHORIZED'];

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const isUuid = (v) => typeof v === 'string' && UUID_PATTERN.test(v);

  /** Upper case, with everything but A–Z and 0–9 dropped: "abc-234" and "ABC 234" both give "ABC234". */
  function stripCode(raw) {
    return String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /** What the code field shows while typing: stripped, at most 6 characters. A pasted share link gives its code. */
  function cleanCodeInput(raw) {
    const fromLink = /[?&]room=([^&#\s]+)/i.exec(String(raw == null ? '' : raw));
    return stripCode(fromLink ? fromLink[1] : raw).slice(0, CODE_LENGTH);
  }

  /** A valid room code, or null. */
  function normalizeCode(raw) {
    const code = stripCode(raw);
    return CODE_PATTERN.test(code) ? code : null;
  }

  /** The ?room= value of a location.search string, stripped (it may still be invalid), or null when there is none. */
  function parseRoomParam(search) {
    let value;
    try {
      value = new URLSearchParams(search || '').get('room');
    } catch (e) {
      return null;
    }
    return value == null ? null : stripCode(value);
  }

  /** The same URL without its ?room= parameter (other parameters and the hash stay), for history.replaceState. */
  function withoutRoomParam(href) {
    const url = new URL(href);
    url.searchParams.delete('room');
    return url.toString();
  }

  /** Share link: the current origin + path, then ?room=CODE. Any other query and the hash are dropped. */
  function shareUrl(href, code) {
    const url = new URL(href);
    url.search = '?room=' + encodeURIComponent(code);
    url.hash = '';
    return url.toString();
  }

  /** trim + NFC, then 1–16 characters (code points, like the server). The server also rejects control characters. */
  function cleanNickname(raw) {
    if (typeof raw !== 'string') return null;
    const value = raw.trim().normalize('NFC');
    const length = Array.from(value).length;
    return length >= 1 && length <= NICKNAME_MAX_LENGTH ? value : null;
  }

  function base64UrlDecode(part) {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  }

  /** I8: only the publishable key (sb_publishable_…) or the legacy anon JWT may reach the browser. */
  function isPublishableKey(key) {
    if (typeof key !== 'string' || !key) return false;
    if (key.startsWith('sb_publishable_')) return true;
    const parts = key.split('.');
    if (parts.length !== 3) return false;
    try {
      return JSON.parse(base64UrlDecode(parts[1])).role === 'anon';
    } catch (e) {
      return false;
    }
  }

  function validConfig(c) {
    if (!c || typeof c !== 'object' || typeof c.supabaseUrl !== 'string' || !c.supabaseUrl) return null;
    let url;
    try {
      url = new URL(c.supabaseUrl);
    } catch (e) {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!isPublishableKey(c.supabaseKey)) return null;
    return { supabaseUrl: url.origin, supabaseKey: c.supabaseKey };
  }

  /**
   * The Supabase config to use, or null when online play is not set up. `devJson` is the local-development override
   * (localStorage['theMind.online.dev']) and wins when it is valid. A key that is not publishable is ignored (I8).
   */
  function resolveConfig(committed, devJson) {
    if (devJson) {
      try {
        const dev = validConfig(JSON.parse(devJson));
        if (dev) return dev;
      } catch (e) { /* a broken override falls back to the committed config */ }
    }
    return validConfig(committed);
  }

  /** Error from a `rooms` / `room-action` response. Every 401 is UNAUTHORIZED (the gateway has its own body). */
  function errorFromResponse(status, body) {
    if (status === 401) return { code: 'UNAUTHORIZED' };
    const e = body && typeof body === 'object' ? body.error : null;
    if (e && typeof e.code === 'string') {
      const out = { code: e.code };
      if (isUuid(e.roomId)) out.roomId = e.roomId;
      return out;
    }
    if (status === 429) return { code: 'RATE_LIMITED' };
    return { code: 'INTERNAL' };
  }

  /** Error code for a supabase-js Auth error: no status or a 5xx gateway answer means the server is out of reach. */
  function authErrorCode(err) {
    const status = err && err.status;
    if (!status || (err && err.name === 'AuthRetryableFetchError') || status >= 502) return 'NETWORK';
    if (status === 429) return 'RATE_LIMITED';
    return 'UNAUTHORIZED';
  }

  /** i18n key of the friendly message for an error code. Unknown codes get the generic message. */
  function errorKey(code) {
    return Object.prototype.hasOwnProperty.call(ERROR_KEYS, code) ? ERROR_KEYS[code] : ERROR_KEYS.INTERNAL;
  }

  const isRetryable = (code) => RETRYABLE.includes(code);

  /** User ids with at least one live Presence connection. Presence is keyed on the user id. */
  function onlineUserIds(presenceState) {
    const ids = new Set();
    for (const key in presenceState || {}) {
      if (Array.isArray(presenceState[key]) && presenceState[key].length) ids.add(key);
    }
    return ids;
  }

  /**
   * The 4 seats of the lobby: room_players rows (seated, not left) merged with Realtime Presence.
   * → [{ seat, empty: true } | { seat, empty: false, userId, nickname, host, you, online }]
   */
  function mergeSeats(players, presenceState, ids) {
    const hostId = ids && ids.hostId;
    const meId = ids && ids.meId;
    const online = onlineUserIds(presenceState);
    const seats = [];
    for (let seat = 0; seat < MAX_SEATS; seat++) seats.push({ seat, empty: true });
    for (const p of players || []) {
      if (!p || p.left_at || !Number.isInteger(p.seat) || p.seat < 0 || p.seat >= MAX_SEATS) continue;
      seats[p.seat] = {
        seat: p.seat,
        empty: false,
        userId: p.user_id,
        nickname: p.nickname,
        host: p.user_id === hostId,
        you: p.user_id === meId,
        online: online.has(p.user_id),
      };
    }
    return seats;
  }

  /**
   * Whether the Start button works, and the status line to show.
   * → { canStart, reason } with reason 'waitHost' (not the host), 'needPlayers', 'needOnline' or 'ready'.
   */
  function startState(seats, isHost) {
    const seated = (seats || []).filter((s) => !s.empty);
    if (!isHost) return { canStart: false, reason: 'waitHost' };
    if (seated.length < MIN_PLAYERS || seated.length > MAX_SEATS) return { canStart: false, reason: 'needPlayers' };
    if (!seated.every((s) => s.online)) return { canStart: false, reason: 'needOnline' };
    return { canStart: true, reason: 'ready' };
  }

  /** Who joined and who left between two player lists, by user id. → { joined: [nickname], left: [nickname] } */
  function diffPlayers(before, after) {
    const seated = (list) => new Map((list || []).filter((p) => p && !p.left_at).map((p) => [p.user_id, p.nickname]));
    const a = seated(before);
    const b = seated(after);
    const joined = [];
    const left = [];
    for (const [id, nick] of b) if (!a.has(id)) joined.push(nick);
    for (const [id, nick] of a) if (!b.has(id)) left.push(nick);
    return { joined, left };
  }

  const isActiveStatus = (status) => ACTIVE_STATUSES.includes(status);

  return {
    CODE_ALPHABET, CODE_PATTERN, CODE_LENGTH, MAX_SEATS, MIN_PLAYERS, NICKNAME_MAX_LENGTH, ERROR_KEYS,
    esc, isUuid, stripCode, cleanCodeInput, normalizeCode, parseRoomParam, withoutRoomParam, shareUrl, cleanNickname,
    isPublishableKey, resolveConfig, errorFromResponse, authErrorCode, errorKey, isRetryable, onlineUserIds,
    mergeSeats, startState, diffPlayers, isActiveStatus,
  };
});
