// MIND-03 · rooms lobby business rules (AC3), room codes (AC4) and the HTTP contract, with an in-memory repository.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoomsService, generateRoomCode, normalizeRoomCode, normalizeNickname, nicknameKey,
  ROOM_CODE_PATTERN, ROOM_CODE_ALPHABET, RATE_LIMITS, MAX_CONFLICT_RETRIES, RoomVersionConflictError,
} from '../supabase/functions/_shared/rooms-rules.mjs';
import { createMemoryRoomsRepo } from '../supabase/functions/_shared/rooms-memory-repo.mjs';
import { createRoomsHandler, CORS_HEADERS } from '../supabase/functions/_shared/rooms-http.mjs';

const user = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const [HOST, B, C, D, E] = [1, 2, 3, 4, 5].map(user);

let t, repo, rooms;
beforeEach(() => {
  t = 1_000_000;
  repo = createMemoryRoomsRepo({ now: () => t });
  rooms = createRoomsService({ repo });
});

const run = (userId, action, input) => rooms.run(userId, action, input);
const data = async (p) => {
  const r = await p;
  assert.equal(r.ok, true, JSON.stringify(r.error));
  return r.data;
};
const errorOf = async (p) => {
  const r = await p;
  assert.equal(r.ok, false, `expected an error, got ${JSON.stringify(r.data)}`);
  return r.error;
};
const roomRow = (id) => repo.state.rooms.find((r) => r.id === id);
const seated = (roomId) => repo.state.players.filter((p) => p.roomId === roomId && p.leftAt == null)
  .sort((a, b) => a.seat - b.seat).map((p) => [p.userId, p.seat, p.nickname]);

async function roomWith(n, variant) {
  const created = await data(run(HOST, 'create', { nickname: 'Host', variant }));
  const others = [B, C, D, E].slice(0, n - 1);
  for (const [i, u] of others.entries()) await data(run(u, 'join', { code: created.code, nickname: `P${i + 2}` }));
  return created;
}

describe('create', () => {
  it('creates a lobby room with the creator as host in seat 0', async () => {
    const r = await data(run(HOST, 'create', { nickname: '  Ayşe  ', variant: 'dual' }));
    assert.match(r.code, ROOM_CODE_PATTERN);
    assert.equal(r.seat, 0);
    assert.deepEqual(Object.keys(r).sort(), ['code', 'roomId', 'seat']);
    const row = roomRow(r.roomId);
    assert.deepEqual([row.hostId, row.variant, row.status, row.code], [HOST, 'dual', 'lobby', r.code]);
    assert.deepEqual(seated(r.roomId), [[HOST, 0, 'Ayşe']]);
  });

  it('defaults to Classic and rejects unknown modes', async () => {
    const r = await data(run(HOST, 'create', { nickname: 'Host' }));
    assert.equal(roomRow(r.roomId).variant, 'classic');
    assert.equal((await errorOf(run(B, 'create', { nickname: 'B', variant: 'extreme' }))).code, 'INVALID_INPUT');
  });

  it('retries when a generated code is already used by an active room', async () => {
    const codes = ['AAAAAA', 'AAAAAA', 'AAAAAA', 'BBBBBB'];
    rooms = createRoomsService({ repo, randomCode: () => codes.shift() });
    assert.equal((await data(run(HOST, 'create', { nickname: 'H' }))).code, 'AAAAAA');
    assert.equal((await data(run(B, 'create', { nickname: 'B' }))).code, 'BBBBBB');
  });

  it('reuses the code of a room that is no longer active', async () => {
    rooms = createRoomsService({ repo, randomCode: () => 'CCCCCC' });
    const first = await data(run(HOST, 'create', { nickname: 'H' }));
    repo.setRoomStatus(first.roomId, 'finished');
    assert.equal((await data(run(B, 'create', { nickname: 'B' }))).code, 'CCCCCC');
  });

  it('gives up with an error (and rolls back) when no free code is found', async () => {
    rooms = createRoomsService({ repo, randomCode: () => 'DDDDDD', maxCodeAttempts: 3 });
    await data(run(HOST, 'create', { nickname: 'H' }));
    await assert.rejects(run(B, 'create', { nickname: 'B' }), /No free room code/);
    assert.equal(repo.state.rooms.length, 1);
  });
});

describe('join', () => {
  it('joins with the exact code and takes the next free seat', async () => {
    const { code, roomId } = await roomWith(1);
    assert.deepEqual(await data(run(B, 'join', { code, nickname: 'Bora' })), { roomId, seat: 1 });
    assert.deepEqual(seated(roomId), [[HOST, 0, 'Host'], [B, 1, 'Bora']]);
  });

  it('accepts the code in lowercase, with a dash or with spaces', async () => {
    const { code, roomId } = await roomWith(1);
    assert.equal((await data(run(B, 'join', { code: code.toLowerCase(), nickname: 'B' }))).roomId, roomId);
    assert.equal((await data(run(C, 'join', { code: `${code.slice(0, 3)}-${code.slice(3)}`, nickname: 'C' }))).roomId, roomId);
    assert.equal((await data(run(D, 'join', { code: ` ${code.slice(0, 3).toLowerCase()} ${code.slice(3)} `, nickname: 'D' }))).roomId, roomId);
  });

  it('a 5th player gets ROOM_FULL', async () => {
    const { code, roomId } = await roomWith(4);
    assert.equal(seated(roomId).length, 4);
    const err = await errorOf(run(E, 'join', { code, nickname: 'Fifth' }));
    assert.equal(err.code, 'ROOM_FULL');
  });

  it('a nickname already used in the room gets NICKNAME_TAKEN, ignoring case', async () => {
    const { code } = await roomWith(1);
    await data(run(B, 'join', { code, nickname: 'Irmak' }));
    for (const nickname of ['host', 'HOST', 'irmak', 'IRMAK', 'ırmak', ' Irmak ']) {
      assert.equal((await errorOf(run(C, 'join', { code, nickname }))).code, 'NICKNAME_TAKEN', nickname);
    }
    await data(run(C, 'join', { code, nickname: 'Irmak2' }));
  });

  it('a bad nickname gets INVALID_NICKNAME: empty, 17+ characters or control characters', async () => {
    const { code } = await roomWith(1);
    for (const nickname of [undefined, '', '   ', 'x'.repeat(17), 'ab\u0007cd', 'tab\there', 'line\nbreak', 'bidi\u202Eevil', 'del\u007F']) {
      assert.equal((await errorOf(run(B, 'join', { code, nickname }))).code, 'INVALID_NICKNAME', JSON.stringify(nickname));
    }
    assert.equal((await errorOf(run(B, 'join', { code, nickname: 42 }))).code, 'INVALID_INPUT');
    assert.equal((await data(run(B, 'join', { code, nickname: 'x'.repeat(16) }))).seat, 1);
  });

  it('a new player cannot join a room that is playing: GAME_IN_PROGRESS', async () => {
    const { code, roomId } = await roomWith(2);
    repo.setRoomStatus(roomId, 'playing');
    assert.equal((await errorOf(run(C, 'join', { code, nickname: 'Late' }))).code, 'GAME_IN_PROGRESS');
  });

  it('rejoining returns the same seat, in the lobby and while playing', async () => {
    const { code, roomId } = await roomWith(3);
    assert.deepEqual(await data(run(C, 'join', { code, nickname: 'ignored' })), { roomId, seat: 2 });
    repo.setRoomStatus(roomId, 'playing');
    assert.deepEqual(await data(run(C, 'join', { code: code.toLowerCase() })), { roomId, seat: 2 });
    assert.deepEqual(await data(run(HOST, 'join', { code })), { roomId, seat: 0 });
    assert.equal(seated(roomId).length, 3);
  });

  it('unknown and malformed codes get ROOM_NOT_FOUND; finished rooms cannot be joined', async () => {
    const { code, roomId } = await roomWith(1);
    for (const c of ['ZZZZZZ', 'ABC', 'ABCDEFG', 'IIIIII', '000000', '']) {
      assert.equal((await errorOf(run(B, 'join', { code: c, nickname: 'B' }))).code, 'ROOM_NOT_FOUND', c);
    }
    assert.equal((await errorOf(run(B, 'join', { code: 123456, nickname: 'B' }))).code, 'INVALID_INPUT');
    repo.setRoomStatus(roomId, 'finished');
    assert.equal((await errorOf(run(B, 'join', { code, nickname: 'B' }))).code, 'ROOM_NOT_FOUND');
  });

  it('seats freed in the lobby are reused', async () => {
    const { code, roomId } = await roomWith(3);
    await data(run(B, 'leave', { roomId }));
    assert.equal((await data(run(D, 'join', { code, nickname: 'D' }))).seat, 1);
  });

  it('a player who left a finished room can sit down again when it reopens as a lobby', async () => {
    const { code, roomId } = await roomWith(2);
    repo.setRoomStatus(roomId, 'finished');
    await data(run(B, 'leave', { roomId }));
    repo.setRoomStatus(roomId, 'lobby');
    assert.deepEqual(await data(run(B, 'join', { code, nickname: 'Back' })), { roomId, seat: 1 });
    assert.deepEqual(seated(roomId), [[HOST, 0, 'Host'], [B, 1, 'Back']]);
    assert.equal(repo.state.players.filter((p) => p.userId === B).length, 1);
  });
});

describe('one active room per user', () => {
  it('joining another lobby leaves the old lobby first (host role passes on)', async () => {
    const a = await roomWith(2);
    rooms = createRoomsService({ repo });
    const b = await data(run(C, 'create', { nickname: 'C' }));
    await data(run(HOST, 'join', { code: b.code, nickname: 'Host' }));
    assert.deepEqual(seated(a.roomId), [[B, 1, 'P2']]);
    assert.equal(roomRow(a.roomId).hostId, B);
    assert.deepEqual(seated(b.roomId), [[C, 0, 'C'], [HOST, 1, 'Host']]);
  });

  it('creating a room leaves the old lobby; the last one out abandons it', async () => {
    const a = await roomWith(1);
    const b = await data(run(HOST, 'create', { nickname: 'Host' }));
    assert.equal(roomRow(a.roomId).status, 'abandoned');
    assert.notEqual(a.roomId, b.roomId);
  });

  it('while seated in a playing room, create and join get ALREADY_IN_GAME with that room id', async () => {
    const a = await roomWith(2);
    repo.setRoomStatus(a.roomId, 'playing');
    const other = await data(run(C, 'create', { nickname: 'C' }));
    const e1 = await errorOf(run(B, 'join', { code: other.code, nickname: 'B' }));
    const e2 = await errorOf(run(B, 'create', { nickname: 'B' }));
    for (const e of [e1, e2]) assert.deepEqual([e.code, e.roomId], ['ALREADY_IN_GAME', a.roomId]);
    assert.equal(seated(other.roomId).length, 1);
  });

  it('a failed join does not leave the current lobby', async () => {
    const a = await roomWith(2);
    const full = await data(run(C, 'create', { nickname: 'C' }));
    await data(run(D, 'join', { code: full.code, nickname: 'P2' }));
    assert.equal((await errorOf(run(B, 'join', { code: full.code, nickname: 'p2' }))).code, 'NICKNAME_TAKEN');
    assert.deepEqual(seated(a.roomId), [[HOST, 0, 'Host'], [B, 1, 'P2']]);
  });
});

describe('leave', () => {
  it('the host leaving hands the host role to the earliest-joined player left', async () => {
    const { roomId } = await roomWith(1);
    t += 1000; await data(run(C, 'join', { code: roomRow(roomId).code, nickname: 'C' }));
    t += 1000; await data(run(B, 'join', { code: roomRow(roomId).code, nickname: 'B' }));
    assert.deepEqual(await data(run(HOST, 'leave', { roomId })), { roomId });
    assert.equal(roomRow(roomId).hostId, C);
    assert.equal(roomRow(roomId).status, 'lobby');
    assert.deepEqual(seated(roomId).map(([u, s]) => [u, s]), [[C, 1], [B, 2]]);
  });

  it('the last player leaving makes the room abandoned', async () => {
    const { roomId } = await roomWith(2);
    await data(run(B, 'leave', { roomId }));
    assert.equal(roomRow(roomId).status, 'lobby');
    await data(run(HOST, 'leave', { roomId }));
    assert.equal(roomRow(roomId).status, 'abandoned');
    assert.deepEqual(seated(roomId), []);
  });

  it('leaving a playing room abandons it and appends gameAborted {by} with the seat-based player id', async () => {
    const { roomId } = await roomWith(3);
    repo.setRoomStatus(roomId, 'playing');
    await data(run(C, 'leave', { roomId }));
    assert.equal(roomRow(roomId).status, 'abandoned');
    assert.deepEqual(repo.state.events, [{ roomId, seq: 1, type: 'gameAborted', payload: { by: 's2' } }]);
    assert.ok(repo.state.players.find((p) => p.userId === C).leftAt != null);
  });

  it('every change bumps the room version', async () => {
    const { roomId, code } = await roomWith(1);
    const v0 = roomRow(roomId).version;
    await data(run(B, 'join', { code, nickname: 'B' }));
    await data(run(HOST, 'setVariant', { roomId, variant: 'blind' }));
    await data(run(B, 'leave', { roomId }));
    assert.equal(roomRow(roomId).version, v0 + 3);
  });

  it('leaving a room you are not in gets ROOM_NOT_FOUND; a bad id gets INVALID_INPUT', async () => {
    const { roomId } = await roomWith(1);
    assert.equal((await errorOf(run(B, 'leave', { roomId }))).code, 'ROOM_NOT_FOUND');
    assert.equal((await errorOf(run(B, 'leave', { roomId: user(99) }))).code, 'ROOM_NOT_FOUND');
    assert.equal((await errorOf(run(B, 'leave', { roomId: 'nope' }))).code, 'INVALID_INPUT');
  });
});

describe('setVariant', () => {
  it('the host can change the mode in the lobby', async () => {
    const { roomId } = await roomWith(2);
    assert.deepEqual(await data(run(HOST, 'setVariant', { roomId, variant: 'reverse' })), { roomId, variant: 'reverse' });
    assert.equal(roomRow(roomId).variant, 'reverse');
  });

  it('a non-host gets NOT_HOST', async () => {
    const { roomId } = await roomWith(2);
    assert.equal((await errorOf(run(B, 'setVariant', { roomId, variant: 'blind' }))).code, 'NOT_HOST');
    assert.equal(roomRow(roomId).variant, 'classic');
  });

  it('only in the lobby, only members, only known modes', async () => {
    const { roomId } = await roomWith(2);
    assert.equal((await errorOf(run(C, 'setVariant', { roomId, variant: 'blind' }))).code, 'ROOM_NOT_FOUND');
    assert.equal((await errorOf(run(HOST, 'setVariant', { roomId, variant: 'chaos' }))).code, 'INVALID_INPUT');
    repo.setRoomStatus(roomId, 'playing');
    assert.equal((await errorOf(run(HOST, 'setVariant', { roomId, variant: 'blind' }))).code, 'GAME_IN_PROGRESS');
  });
});

describe('rate limits', () => {
  it(`create: at most ${RATE_LIMITS.create.max} rooms per hour`, async () => {
    for (let i = 0; i < 10; i++) { await data(run(HOST, 'create', { nickname: 'H' })); t += 60_000; }
    assert.equal((await errorOf(run(HOST, 'create', { nickname: 'H' }))).code, 'RATE_LIMITED');
    await data(run(B, 'create', { nickname: 'B' }));
    t = 1_000_000 + 3600 * 1000 + 1;
    await data(run(HOST, 'create', { nickname: 'H' }));
  });

  it('create: invalid requests do not use up the limit', async () => {
    for (let i = 0; i < 15; i++) await errorOf(run(HOST, 'create', { nickname: '' }));
    await data(run(HOST, 'create', { nickname: 'H' }));
  });

  it(`join: at most ${RATE_LIMITS.join.max} attempts per 10 minutes, failed codes included`, async () => {
    const { code } = await roomWith(1);
    for (let i = 0; i < 19; i++) assert.equal((await errorOf(run(B, 'join', { code: 'ZZZZZZ', nickname: 'B' }))).code, 'ROOM_NOT_FOUND');
    await data(run(B, 'join', { code, nickname: 'B' }));
    const err = await errorOf(run(B, 'join', { code, nickname: 'B' }));
    assert.equal(err.code, 'RATE_LIMITED');
    assert.equal((await errorOf(run(C, 'join', { code: 'ZZZZZZ', nickname: 'C' }))).code, 'ROOM_NOT_FOUND');
    t += 600 * 1000;
    assert.equal((await data(run(B, 'join', { code, nickname: 'B' }))).seat, 1);
  });
});

describe('room codes (AC4)', () => {
  it('1,000 generated codes all match ^[A-HJ-NP-Z2-9]{6}$ and use the whole alphabet', () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) {
      const code = generateRoomCode();
      assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
      for (const ch of code) seen.add(ch);
    }
    assert.equal(ROOM_CODE_ALPHABET.length, 32);
    assert.equal(seen.size, 32);
  });

  it('every byte value maps into the alphabet', () => {
    for (let b = 0; b < 256; b++) assert.match(generateRoomCode((bytes) => bytes.fill(b)), ROOM_CODE_PATTERN);
  });

  it('normalizes typed codes', () => {
    assert.equal(normalizeRoomCode('ab-c 2 3 4'), 'ABC234');
    assert.equal(normalizeRoomCode('abc23'), null);
    assert.equal(normalizeRoomCode('ABC10O'), null);
    assert.equal(normalizeRoomCode(null), null);
  });
});

describe('nicknames', () => {
  it('trims, applies NFC and counts characters, not bytes', () => {
    assert.deepEqual(normalizeNickname('  Cafe\u0301  '), { ok: true, data: 'Café' });
    assert.equal(normalizeNickname('ğüşöçıİ'.repeat(2) + 'ab').ok, true);
    assert.equal(normalizeNickname('😀'.repeat(16)).ok, true);
    assert.equal(normalizeNickname('😀'.repeat(17)).ok, false);
  });

  it('compares nicknames ignoring case, including Turkish I/ı/İ/i', () => {
    assert.equal(nicknameKey('İREM'), nicknameKey('irem'));
    assert.equal(nicknameKey('IŞIK'), nicknameKey('ışık'));
    assert.equal(nicknameKey('Ayşe'), nicknameKey('AYŞE'));
    assert.notEqual(nicknameKey('Ayşe'), nicknameKey('Ayse'));
  });
});

describe('service', () => {
  it('rejects unknown actions and missing users', async () => {
    assert.equal((await errorOf(run(HOST, 'kick', {}))).code, 'INVALID_INPUT');
    assert.equal((await errorOf(run(HOST, '__proto__', {}))).code, 'INVALID_INPUT');
    assert.equal((await errorOf(run('not-a-uuid', 'create', { nickname: 'x' }))).code, 'UNAUTHORIZED');
  });

  it('runs transactions one at a time, so parallel joins never overfill a room', async () => {
    const { code, roomId } = await roomWith(1);
    const users = Array.from({ length: 8 }, (_, i) => user(100 + i));
    const results = await Promise.all(users.map((u, i) => run(u, 'join', { code, nickname: `N${i}` })));
    assert.equal(results.filter((r) => r.ok).length, 3);
    assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.error.code), Array(5).fill('ROOM_FULL'));
    assert.deepEqual(seated(roomId).map(([, s]) => s), [0, 1, 2, 3]);
  });
});

describe('compare-and-swap commits (I6)', () => {
  // Hands out rooms with an outdated version, as if another commit had landed after they were read.
  function staleRepo(inner, staleReads) {
    let left = staleReads;
    const stats = { transactions: 0 };
    return {
      stats,
      transaction: (fn) => inner.transaction((tx) => {
        stats.transactions++;
        return fn({
          ...tx,
          async lockRooms(ids) {
            const locked = await tx.lockRooms(ids);
            if (left <= 0) return locked;
            left--;
            return locked.map((r) => ({ ...r, version: r.version - 1 }));
          },
        });
      }),
    };
  }

  it('a stale version is never committed: the action is rolled back and run again', async () => {
    const { code, roomId } = await roomWith(1);
    const stale = staleRepo(repo, 2);
    rooms = createRoomsService({ repo: stale });
    assert.deepEqual(await data(run(B, 'join', { code, nickname: 'B' })), { roomId, seat: 1 });
    assert.equal(stale.stats.transactions, 3);
    assert.deepEqual(seated(roomId).map(([u]) => u), [HOST, B]);
    assert.equal(roomRow(roomId).version, 1);
    assert.equal(repo.state.hits.filter((h) => h.userId === B).length, 1, 'rolled-back attempts leave no rate-limit hit');
  });

  it(`gives up after ${MAX_CONFLICT_RETRIES} retries and changes nothing`, async () => {
    const { code, roomId } = await roomWith(2);
    const before = structuredClone(repo.state);
    const stale = staleRepo(repo, Infinity);
    rooms = createRoomsService({ repo: stale });
    await assert.rejects(run(C, 'join', { code, nickname: 'C' }), { name: 'RoomVersionConflictError', roomId });
    await assert.rejects(run(HOST, 'setVariant', { roomId, variant: 'dual' }), { name: 'RoomVersionConflictError' });
    await assert.rejects(run(B, 'leave', { roomId }), { name: 'RoomVersionConflictError' });
    assert.equal(stale.stats.transactions, 3 * (MAX_CONFLICT_RETRIES + 1));
    assert.deepEqual(repo.state, before);
  });

  it('the in-memory repository refuses a version it does not have', async () => {
    const { roomId } = await roomWith(1);
    const err = await repo.transaction((tx) => tx.updateRoom({ id: roomId, version: 7 }, { status: 'abandoned' })).catch((e) => e);
    assert.ok(err instanceof RoomVersionConflictError);
    assert.equal(roomRow(roomId).status, 'lobby');
  });
});

describe('HTTP handler', () => {
  let handler, logged;
  beforeEach(() => {
    logged = [];
    handler = createRoomsHandler({
      service: rooms,
      authenticate: async (req) => ({ 'Bearer host-token': HOST, 'Bearer b-token': B })[req.headers.get('Authorization')] || null,
      log: { error: (...a) => logged.push(a) },
    });
  });
  const post = (body, token = 'host-token', init = {}) => handler(new Request('http://x/rooms', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}),
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  }));

  it('answers the CORS preflight', async () => {
    const res = await handler(new Request('http://x/rooms', { method: 'OPTIONS' }));
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(res.headers.get('Access-Control-Allow-Headers'), /authorization/);
    assert.match(res.headers.get('Access-Control-Allow-Methods'), /POST/);
  });

  it('returns JSON with CORS headers on success', async () => {
    const res = await post({ action: 'create', nickname: 'Host', variant: 'blind' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Type'), /application\/json/);
    for (const [k, v] of Object.entries(CORS_HEADERS)) assert.equal(res.headers.get(k), v);
    const body = await res.json();
    assert.match(body.code, ROOM_CODE_PATTERN);
    const joined = await post({ action: 'join', code: body.code, nickname: 'B' }, 'b-token');
    assert.deepEqual(await joined.json(), { roomId: body.roomId, seat: 1 });
  });

  it('maps errors to 4xx with {error: {code, message}}', async () => {
    const cases = [
      [post({ action: 'join', code: 'ZZZZZZ', nickname: 'x' }), 404, 'ROOM_NOT_FOUND'],
      [post({ action: 'create', nickname: '' }), 400, 'INVALID_NICKNAME'],
      [post({ action: 'nope' }), 400, 'INVALID_INPUT'],
      [post('{not json'), 400, 'INVALID_INPUT'],
      [post([1, 2]), 400, 'INVALID_INPUT'],
      [post({ nickname: 'no action' }), 400, 'INVALID_INPUT'],
      [post({ action: 'create', nickname: 'x' }, null), 401, 'UNAUTHORIZED'],
      [post({ action: 'create', nickname: 'x' }, 'forged-token'), 401, 'UNAUTHORIZED'],
      [post({ action: 'create', nickname: 'x'.repeat(5000) }), 413, 'INVALID_INPUT'],
      [handler(new Request('http://x/rooms', { method: 'GET' })), 405, 'INVALID_INPUT'],
    ];
    for (const [p, status, code] of cases) {
      const res = await p;
      assert.equal(res.status, status, code);
      const body = await res.json();
      assert.equal(body.error.code, code);
      assert.equal(typeof body.error.message, 'string');
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    }
  });

  it('NOT_HOST is 403, RATE_LIMITED is 429, ALREADY_IN_GAME carries the room id', async () => {
    const { roomId, code } = await (await post({ action: 'create', nickname: 'Host' })).json();
    await post({ action: 'join', code, nickname: 'B' }, 'b-token');
    const notHost = await post({ action: 'setVariant', roomId, variant: 'dual' }, 'b-token');
    assert.equal(notHost.status, 403);
    repo.setRoomStatus(roomId, 'playing');
    const busy = await post({ action: 'create', nickname: 'B' }, 'b-token');
    assert.equal(busy.status, 409);
    assert.deepEqual((await busy.json()).error.roomId, roomId);
    for (let i = 0; i < 20; i++) await post({ action: 'join', code: 'ZZZZZZ', nickname: 'B' }, 'b-token');
    assert.equal((await post({ action: 'join', code: 'ZZZZZZ', nickname: 'B' }, 'b-token')).status, 429);
  });

  it('unexpected errors become 500 INTERNAL without details', async () => {
    const broken = createRoomsHandler({
      service: { run: async () => { throw new Error('db exploded: password=hunter2'); } },
      authenticate: async () => HOST,
      log: { error: (...a) => logged.push(a) },
    });
    const res = await broken(new Request('http://x/rooms', { method: 'POST', body: '{"action":"create"}' }));
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.equal(JSON.parse(text).error.code, 'INTERNAL');
    assert.ok(!text.includes('hunter2'));
    assert.equal(logged.length, 1);
  });
});
