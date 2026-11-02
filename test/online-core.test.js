'use strict';

// MIND-05 AC8 · Pure helpers of the online lobby (online/online-core.js).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../online/online-core.js');

const ROOM = '0b5c2b1e-8a4f-4c55-9d3a-6e2f7a1c9b20';
const jwt = (payload) => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');

describe('room codes', () => {
  test('the alphabet and pattern match the server rules', async () => {
    const rules = await import('../supabase/functions/_shared/rooms-rules.mjs');
    assert.equal(Core.CODE_ALPHABET, rules.ROOM_CODE_ALPHABET);
    assert.equal(String(Core.CODE_PATTERN), String(rules.ROOM_CODE_PATTERN));
    for (const raw of ['abc-234', 'ABC 234', ' xyz789 ', 'ABC2345', 'ABC-1O4', '', 'abc_234']) {
      const server = rules.normalizeRoomCode(raw);
      if (server) assert.equal(Core.normalizeCode(raw), server, raw);
    }
  });

  test('normalizeCode accepts lower case, dashes and spaces', () => {
    assert.equal(Core.normalizeCode('abc-234'), 'ABC234');
    assert.equal(Core.normalizeCode('ABC 234'), 'ABC234');
    assert.equal(Core.normalizeCode('  a b c - 2 3 4 '), 'ABC234');
    assert.equal(Core.normalizeCode('xyz789'), 'XYZ789');
  });

  test('normalizeCode refuses wrong lengths and the characters codes never use', () => {
    for (const bad of ['', 'ABC23', 'ABC2345', 'ABC-123', 'ABCO23', 'ABCI23', 'ABC023', null, undefined, 42]) {
      assert.equal(Core.normalizeCode(bad), null, String(bad));
    }
  });

  test('cleanCodeInput upper-cases, drops separators and keeps 6 characters while typing', () => {
    assert.equal(Core.cleanCodeInput('abc-2'), 'ABC2');
    assert.equal(Core.cleanCodeInput('abc 234 567'), 'ABC234');
    assert.equal(Core.cleanCodeInput('çab!c'), 'ABC');
    assert.equal(Core.cleanCodeInput(null), '');
  });

  test('cleanCodeInput takes the code out of a pasted share link', () => {
    assert.equal(Core.cleanCodeInput('https://example.org/the-mind/?room=xyz789'), 'XYZ789');
    assert.equal(Core.cleanCodeInput('see https://x.y/?a=1&room=ABC-234#lobby'), 'ABC234');
  });
});

describe('share link', () => {
  test('parseRoomParam reads ?room= and strips it to letters and digits', () => {
    assert.equal(Core.parseRoomParam('?room=abc-234'), 'ABC234');
    assert.equal(Core.parseRoomParam('?x=1&room=ABC%20234'), 'ABC234');
    assert.equal(Core.parseRoomParam('?room=ABC+234'), 'ABC234');
    assert.equal(Core.parseRoomParam('?room='), '');
    assert.equal(Core.parseRoomParam('?other=1'), null);
    assert.equal(Core.parseRoomParam(''), null);
    assert.equal(Core.parseRoomParam(undefined), null);
  });

  test('shareUrl is the current origin and path plus ?room=CODE', () => {
    assert.equal(Core.shareUrl('https://abaskal.github.io/the-mind/#lobby', 'ABC234'), 'https://abaskal.github.io/the-mind/?room=ABC234');
    assert.equal(Core.shareUrl('https://x.org/index.html?room=OLD234&lang=tr#online', 'XYZ789'), 'https://x.org/index.html?room=XYZ789');
    assert.equal(Core.shareUrl('http://127.0.0.1:8080/', 'ABC234'), 'http://127.0.0.1:8080/?room=ABC234');
  });

  test('withoutRoomParam removes only ?room=', () => {
    assert.equal(Core.withoutRoomParam('https://x.org/the-mind/?room=ABC234'), 'https://x.org/the-mind/');
    assert.equal(Core.withoutRoomParam('https://x.org/?lang=tr&room=ABC234#online'), 'https://x.org/?lang=tr#online');
    assert.equal(Core.withoutRoomParam('file:///Users/me/TheMind/index.html?room=ABC234'), 'file:///Users/me/TheMind/index.html');
  });

  test('a share link round-trips to the same code', () => {
    const link = Core.shareUrl('https://x.org/the-mind/#lobby', 'K7P2QZ');
    assert.equal(Core.normalizeCode(Core.parseRoomParam(new URL(link).search)), 'K7P2QZ');
  });
});

describe('nicknames', () => {
  test('cleanNickname trims, NFC-normalizes and counts code points like the server', () => {
    assert.equal(Core.cleanNickname('  Ayşe  '), 'Ayşe');
    assert.equal(Core.cleanNickname('Ays\u0327e'), 'Ayşe');
    assert.equal(Core.cleanNickname('🧠'.repeat(16)), '🧠'.repeat(16));
    assert.equal(Core.cleanNickname('x'.repeat(16)), 'x'.repeat(16));
    assert.equal(Core.cleanNickname('x'.repeat(17)), null);
    assert.equal(Core.cleanNickname('   '), null);
    assert.equal(Core.cleanNickname(42), null);
  });
});

describe('config and keys (I8)', () => {
  const pub = 'sb_publishable_example0000000000';

  test('isPublishableKey accepts publishable and anon keys only', () => {
    assert.equal(Core.isPublishableKey(pub), true);
    assert.equal(Core.isPublishableKey(jwt({ role: 'anon', iss: 'supabase' })), true);
    assert.equal(Core.isPublishableKey(jwt({ role: 'service_role', iss: 'supabase' })), false);
    assert.equal(Core.isPublishableKey('sb_secret_example'), false);
    assert.equal(Core.isPublishableKey('not.a.jwt'), false);
    assert.equal(Core.isPublishableKey(''), false);
    assert.equal(Core.isPublishableKey(undefined), false);
  });

  test('resolveConfig: empty committed config means online play is off', () => {
    assert.equal(Core.resolveConfig({ supabaseUrl: '', supabaseKey: '' }, null), null);
    assert.equal(Core.resolveConfig(undefined, null), null);
  });

  test('resolveConfig: the committed config, trimmed to the origin', () => {
    assert.deepEqual(Core.resolveConfig({ supabaseUrl: 'https://abc.supabase.co/', supabaseKey: pub }, null),
      { supabaseUrl: 'https://abc.supabase.co', supabaseKey: pub });
  });

  test('resolveConfig: a valid localStorage override wins, a broken one is ignored', () => {
    const committed = { supabaseUrl: 'https://abc.supabase.co', supabaseKey: pub };
    const dev = JSON.stringify({ supabaseUrl: 'http://127.0.0.1:54321', supabaseKey: pub });
    assert.equal(Core.resolveConfig(committed, dev).supabaseUrl, 'http://127.0.0.1:54321');
    assert.equal(Core.resolveConfig({ supabaseUrl: '', supabaseKey: '' }, dev).supabaseUrl, 'http://127.0.0.1:54321');
    assert.equal(Core.resolveConfig(committed, '{not json').supabaseUrl, 'https://abc.supabase.co');
    assert.equal(Core.resolveConfig(committed, '{"supabaseUrl":"http://127.0.0.1:54321"}').supabaseUrl, 'https://abc.supabase.co');
  });

  test('resolveConfig refuses secret keys and non-http URLs', () => {
    assert.equal(Core.resolveConfig({ supabaseUrl: 'https://abc.supabase.co', supabaseKey: 'sb_secret_x' }, null), null);
    assert.equal(Core.resolveConfig({ supabaseUrl: 'https://abc.supabase.co', supabaseKey: jwt({ role: 'service_role' }) }, null), null);
    assert.equal(Core.resolveConfig({ supabaseUrl: 'javascript:alert(1)', supabaseKey: pub }, null), null);
    assert.equal(Core.resolveConfig({ supabaseUrl: 'not a url', supabaseKey: pub }, null), null);
  });
});

describe('errors → i18n keys', () => {
  const backendCodes = [
    'INVALID_INPUT', 'INVALID_NICKNAME', 'UNAUTHORIZED', 'NOT_HOST', 'ROOM_NOT_FOUND', 'NICKNAME_TAKEN', 'ROOM_FULL',
    'GAME_IN_PROGRESS', 'ALREADY_IN_GAME', 'RATE_LIMITED', 'NOT_A_MEMBER', 'INVALID_MOVE', 'CONFLICT_RETRY', 'INTERNAL',
  ];

  test('every backend error code has its own message', async () => {
    const rooms = await import('../supabase/functions/_shared/rooms-rules.mjs');
    const action = await import('../supabase/functions/_shared/room-action.mjs');
    const codes = new Set([...Object.keys(rooms.ERROR_STATUS), ...Object.keys(action.ERROR_STATUS), 'INTERNAL']);
    for (const code of codes) assert.ok(backendCodes.includes(code), `unmapped backend code ${code}`);
    for (const code of backendCodes) assert.match(Core.errorKey(code), /^online\.err\./, code);
    assert.equal(new Set(backendCodes.map(Core.errorKey)).size, backendCodes.length);
  });

  test('the friendly keys the issue names', () => {
    assert.equal(Core.errorKey('ROOM_FULL'), 'online.err.full');
    assert.equal(Core.errorKey('NICKNAME_TAKEN'), 'online.err.nicknameTaken');
    assert.equal(Core.errorKey('RATE_LIMITED'), 'online.err.rateLimited');
    assert.equal(Core.errorKey('NETWORK'), 'online.err.network');
    assert.equal(Core.errorKey('NOT_CONFIGURED'), 'online.home.off');
  });

  test('unknown codes fall back to the generic message', () => {
    assert.equal(Core.errorKey('SOMETHING_NEW'), 'online.err.internal');
    assert.equal(Core.errorKey(undefined), 'online.err.internal');
    assert.equal(Core.errorKey('__proto__'), 'online.err.internal');
  });

  test('errorFromResponse reads { error: { code, roomId } } and treats every 401 as UNAUTHORIZED', () => {
    assert.deepEqual(Core.errorFromResponse(409, { error: { code: 'ROOM_FULL', message: 'x' } }), { code: 'ROOM_FULL' });
    assert.deepEqual(Core.errorFromResponse(409, { error: { code: 'ALREADY_IN_GAME', roomId: ROOM } }), { code: 'ALREADY_IN_GAME', roomId: ROOM });
    assert.deepEqual(Core.errorFromResponse(409, { error: { code: 'ALREADY_IN_GAME', roomId: '<script>' } }), { code: 'ALREADY_IN_GAME' });
    assert.deepEqual(Core.errorFromResponse(401, { code: 'UNAUTHORIZED_NO_AUTH_HEADER', message: 'x' }), { code: 'UNAUTHORIZED' });
    assert.deepEqual(Core.errorFromResponse(401, { error: { code: 'UNAUTHORIZED' } }), { code: 'UNAUTHORIZED' });
    assert.deepEqual(Core.errorFromResponse(429, null), { code: 'RATE_LIMITED' });
    assert.deepEqual(Core.errorFromResponse(502, null), { code: 'INTERNAL' });
  });

  test('authErrorCode: unreachable, rate-limited or refused', () => {
    assert.equal(Core.authErrorCode({ name: 'AuthRetryableFetchError', status: 0 }), 'NETWORK');
    assert.equal(Core.authErrorCode({ name: 'AuthApiError' }), 'NETWORK');
    assert.equal(Core.authErrorCode({ name: 'AuthApiError', status: 503 }), 'NETWORK');
    assert.equal(Core.authErrorCode({ name: 'AuthApiError', status: 429 }), 'RATE_LIMITED');
    assert.equal(Core.authErrorCode({ name: 'AuthApiError', status: 422 }), 'UNAUTHORIZED');
  });

  test('network and server failures offer a retry; rule violations do not', () => {
    for (const code of ['NETWORK', 'INTERNAL', 'CONFLICT_RETRY', 'UNAUTHORIZED']) assert.equal(Core.isRetryable(code), true, code);
    for (const code of ['ROOM_FULL', 'NICKNAME_TAKEN', 'ROOM_NOT_FOUND', 'RATE_LIMITED', 'INVALID_NICKNAME']) assert.equal(Core.isRetryable(code), false, code);
  });
});

describe('seats and presence', () => {
  const A = 'a0000000-0000-4000-8000-000000000001';
  const B = 'a0000000-0000-4000-8000-000000000002';
  const C = 'a0000000-0000-4000-8000-000000000003';
  const players = [
    { user_id: A, seat: 0, nickname: 'Ayşe', left_at: null },
    { user_id: B, seat: 2, nickname: '<img src=x onerr', left_at: null },
    { user_id: C, seat: 1, nickname: 'Gone', left_at: '2026-11-02T10:00:00Z' },
  ];
  const presence = { [A]: [{ presence_ref: '1' }], [B]: [] , 'not-seated': [{ presence_ref: '2' }] };

  test('mergeSeats puts players in their seats with host, you and presence', () => {
    const seats = Core.mergeSeats(players, presence, { hostId: A, meId: B });
    assert.equal(seats.length, 4);
    assert.deepEqual(seats[0], { seat: 0, empty: false, userId: A, nickname: 'Ayşe', host: true, you: false, online: true });
    assert.deepEqual(seats[1], { seat: 1, empty: true });
    assert.deepEqual(seats[2], { seat: 2, empty: false, userId: B, nickname: '<img src=x onerr', host: false, you: true, online: false });
    assert.deepEqual(seats[3], { seat: 3, empty: true });
  });

  test('mergeSeats ignores players who left and bad seats', () => {
    const seats = Core.mergeSeats([...players, { user_id: 'x', seat: 7, nickname: 'Bad' }, null], {}, {});
    assert.equal(seats.filter((s) => !s.empty).length, 2);
    assert.ok(seats.every((s) => s.empty || s.online === false));
  });

  test('onlineUserIds counts keys with at least one connection', () => {
    assert.deepEqual([...Core.onlineUserIds(presence)].sort(), [A, 'not-seated'].sort());
    assert.equal(Core.onlineUserIds(undefined).size, 0);
  });

  test('startState: host only, 2–4 seated, all online', () => {
    const seat = (online) => ({ empty: false, online });
    const empty = { empty: true };
    assert.deepEqual(Core.startState([seat(true), empty, empty, empty], true), { canStart: false, reason: 'needPlayers' });
    assert.deepEqual(Core.startState([seat(true), seat(false), empty, empty], true), { canStart: false, reason: 'needOnline' });
    assert.deepEqual(Core.startState([seat(true), seat(true), empty, empty], true), { canStart: true, reason: 'ready' });
    assert.deepEqual(Core.startState([seat(true), seat(true), seat(true), seat(true)], true), { canStart: true, reason: 'ready' });
    assert.deepEqual(Core.startState([seat(true), seat(true), empty, empty], false), { canStart: false, reason: 'waitHost' });
    assert.deepEqual(Core.startState([], true), { canStart: false, reason: 'needPlayers' });
  });

  test('diffPlayers names who joined and who left', () => {
    const before = [{ user_id: A, nickname: 'Ayşe' }, { user_id: B, nickname: 'Bora' }];
    const after = [{ user_id: A, nickname: 'Ayşe' }, { user_id: C, nickname: 'Cem' }, { user_id: 'd', nickname: 'Gone', left_at: 'x' }];
    assert.deepEqual(Core.diffPlayers(before, after), { joined: ['Cem'], left: ['Bora'] });
    assert.deepEqual(Core.diffPlayers(null, before), { joined: ['Ayşe', 'Bora'], left: [] });
  });
});

describe('escaping (I7)', () => {
  test('esc turns markup into text', () => {
    assert.equal(Core.esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(Core.esc(`"'&`), '&quot;&#39;&amp;');
  });
});

test('isActiveStatus: lobby and playing only', () => {
  assert.equal(Core.isActiveStatus('lobby'), true);
  assert.equal(Core.isActiveStatus('playing'), true);
  assert.equal(Core.isActiveStatus('finished'), false);
  assert.equal(Core.isActiveStatus('abandoned'), false);
});
