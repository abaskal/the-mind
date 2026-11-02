// MIND-03 · The rooms rules on the real Postgres repository, against a local Supabase database.
// Skipped unless ROOMS_TEST_DB_URL is set:  npm run db:start && npm run test:integration
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomsService, ROOM_CODE_PATTERN } from '../supabase/functions/_shared/rooms-rules.mjs';
import { createPostgresRoomsRepo } from '../supabase/functions/_shared/rooms-postgres-repo.mjs';

const url = process.env.ROOMS_TEST_DB_URL;

describe('rooms rules on Postgres', { skip: !url && 'set ROOMS_TEST_DB_URL to run against a local Supabase database' }, () => {
  let sql, rooms;
  const created = [];

  before(async () => {
    const { default: postgres } = await import('postgres');
    sql = postgres(url, { prepare: false, max: 12, onnotice: () => {} });
    rooms = createRoomsService({ repo: createPostgresRoomsRepo(sql) });
  });
  after(async () => {
    if (!sql) return;
    await sql`delete from public.rooms where host_id = any(${created}::uuid[])`;
    await sql`delete from auth.users where id = any(${created}::uuid[])`;
    await sql.end();
  });

  async function newUsers(n) {
    const rows = await sql`insert into auth.users (id, is_anonymous)
      select gen_random_uuid(), true from generate_series(1, ${n}) returning id`;
    created.push(...rows.map((r) => r.id));
    return rows.map((r) => r.id);
  }
  const ok = async (p) => {
    const r = await p;
    assert.equal(r.ok, true, JSON.stringify(r.error));
    return r.data;
  };
  const err = async (p) => {
    const r = await p;
    assert.equal(r.ok, false, JSON.stringify(r.data));
    return r.error;
  };
  const room = async (id) => (await sql`select * from public.rooms where id = ${id}`)[0];
  const seats = async (id) => (await sql`
    select user_id, seat, nickname from public.room_players where room_id = ${id} and left_at is null order by seat`)
    .map((r) => [r.user_id, r.seat, r.nickname]);

  it('create, join, rename-free rejoin, mode change, host hand-over and abandon', async () => {
    const [host, b, c] = await newUsers(3);
    const r = await ok(rooms.run(host, 'create', { nickname: ' Ayşe ', variant: 'blind' }));
    assert.match(r.code, ROOM_CODE_PATTERN);
    const row = await room(r.roomId);
    assert.deepEqual([row.host_id, row.variant, row.status, row.version], [host, 'blind', 'lobby', 0]);

    const dashed = `${r.code.slice(0, 3).toLowerCase()}-${r.code.slice(3)}`;
    assert.deepEqual(await ok(rooms.run(b, 'join', { code: dashed, nickname: 'İrem' })), { roomId: r.roomId, seat: 1 });
    assert.equal((await err(rooms.run(c, 'join', { code: r.code, nickname: 'irem' }))).code, 'NICKNAME_TAKEN');
    assert.equal((await err(rooms.run(c, 'join', { code: r.code, nickname: 'x\u0000y' }))).code, 'INVALID_NICKNAME');
    await ok(rooms.run(c, 'join', { code: r.code, nickname: 'Can' }));
    assert.deepEqual(await ok(rooms.run(b, 'join', { code: r.code })), { roomId: r.roomId, seat: 1 });

    assert.equal((await err(rooms.run(b, 'setVariant', { roomId: r.roomId, variant: 'dual' }))).code, 'NOT_HOST');
    await ok(rooms.run(host, 'setVariant', { roomId: r.roomId, variant: 'dual' }));
    const before = await room(r.roomId);
    assert.equal(before.variant, 'dual');
    assert.equal(before.version, 3);

    await ok(rooms.run(host, 'leave', { roomId: r.roomId }));
    const after1 = await room(r.roomId);
    assert.equal(after1.host_id, b);
    assert.ok(after1.last_activity_at >= before.last_activity_at);
    assert.deepEqual(await seats(r.roomId), [[b, 1, 'İrem'], [c, 2, 'Can']]);
    await ok(rooms.run(b, 'leave', { roomId: r.roomId }));
    assert.equal((await room(r.roomId)).host_id, c);
    await ok(rooms.run(c, 'leave', { roomId: r.roomId }));
    assert.equal((await room(r.roomId)).status, 'abandoned');
    assert.equal((await err(rooms.run(c, 'leave', { roomId: r.roomId }))).code, 'ROOM_NOT_FOUND');
  });

  it('playing rooms: GAME_IN_PROGRESS, rejoin, ALREADY_IN_GAME, and leaving aborts the game', async () => {
    const [host, b, late] = await newUsers(3);
    const r = await ok(rooms.run(host, 'create', { nickname: 'Host' }));
    await ok(rooms.run(b, 'join', { code: r.code, nickname: 'B' }));
    await sql`update public.rooms set status = 'playing' where id = ${r.roomId}`;

    assert.equal((await err(rooms.run(late, 'join', { code: r.code, nickname: 'Late' }))).code, 'GAME_IN_PROGRESS');
    assert.deepEqual(await ok(rooms.run(b, 'join', { code: r.code.toLowerCase() })), { roomId: r.roomId, seat: 1 });
    const busy = await err(rooms.run(b, 'create', { nickname: 'B' }));
    assert.deepEqual([busy.code, busy.roomId], ['ALREADY_IN_GAME', r.roomId]);
    assert.equal((await err(rooms.run(host, 'setVariant', { roomId: r.roomId, variant: 'blind' }))).code, 'GAME_IN_PROGRESS');

    await ok(rooms.run(b, 'leave', { roomId: r.roomId }));
    assert.equal((await room(r.roomId)).status, 'abandoned');
    const events = await sql`select seq, type, payload from public.room_events where room_id = ${r.roomId}`;
    assert.deepEqual(events.map((e) => [e.seq, e.type, e.payload]), [[1, 'gameAborted', { by: 's1' }]]);
    assert.ok((await sql`select left_at from public.room_players where room_id = ${r.roomId} and user_id = ${b}`)[0].left_at);
  });

  it('a player who left a finished room can sit down again when it reopens as a lobby', async () => {
    const [host, b] = await newUsers(2);
    const r = await ok(rooms.run(host, 'create', { nickname: 'Host' }));
    await ok(rooms.run(b, 'join', { code: r.code, nickname: 'B' }));
    await sql`update public.rooms set status = 'finished' where id = ${r.roomId}`;
    await ok(rooms.run(b, 'leave', { roomId: r.roomId }));
    await sql`update public.rooms set status = 'lobby' where id = ${r.roomId}`;
    assert.deepEqual(await ok(rooms.run(b, 'join', { code: r.code, nickname: 'Back' })), { roomId: r.roomId, seat: 1 });
    assert.deepEqual(await seats(r.roomId), [[host, 0, 'Host'], [b, 1, 'Back']]);
  });

  it('8 players joining at the same time: exactly 3 get the free seats, the rest get ROOM_FULL', async () => {
    const [host, ...crowd] = await newUsers(9);
    const r = await ok(rooms.run(host, 'create', { nickname: 'Host' }));
    const results = await Promise.all(crowd.map((u, i) => rooms.run(u, 'join', { code: r.code, nickname: `P${i}` })));
    assert.equal(results.filter((x) => x.ok).length, 3);
    assert.deepEqual(results.filter((x) => !x.ok).map((x) => x.error.code), Array(5).fill('ROOM_FULL'));
    assert.deepEqual((await seats(r.roomId)).map(([, s]) => s), [0, 1, 2, 3]);
  });

  it('two players swapping lobbies at the same time do not deadlock', async () => {
    const [a, a2, b, b2] = await newUsers(4);
    const x = await ok(rooms.run(a, 'create', { nickname: 'A' }));
    const y = await ok(rooms.run(b, 'create', { nickname: 'B' }));
    await ok(rooms.run(a2, 'join', { code: x.code, nickname: 'A2' }));
    await ok(rooms.run(b2, 'join', { code: y.code, nickname: 'B2' }));
    for (let i = 0; i < 10; i++) {
      const [toX, toY] = i % 2 ? [a, b] : [b, a];
      const res = await Promise.all([
        rooms.run(toY, 'join', { code: y.code, nickname: `S${i}a` }),
        rooms.run(toX, 'join', { code: x.code, nickname: `S${i}b` }),
      ]);
      for (const r of res) assert.equal(r.ok, true, JSON.stringify(r.error));
    }
    for (const u of [a, b]) {
      const [{ n }] = await sql`select count(*)::int as n from public.room_players p join public.rooms r on r.id = p.room_id
        where p.user_id = ${u} and p.left_at is null and r.status in ('lobby', 'playing')`;
      assert.equal(n, 1);
    }
  });

  it('parallel creates by one user leave them seated in exactly one room', async () => {
    const [u] = await newUsers(1);
    const res = await Promise.all(Array.from({ length: 5 }, () => rooms.run(u, 'create', { nickname: 'U' })));
    assert.ok(res.every((r) => r.ok));
    const active = await sql`select r.id from public.room_players p join public.rooms r on r.id = p.room_id
      where p.user_id = ${u} and p.left_at is null and r.status in ('lobby', 'playing')`;
    assert.equal(active.length, 1);
    const abandoned = await sql`select count(*)::int as n from public.rooms where host_id = ${u} and status = 'abandoned'`;
    assert.equal(abandoned[0].n, 4);
  });

  it('rate limits use the database clock; failed join attempts are committed', async () => {
    const [u, v] = await newUsers(2);
    assert.equal((await err(rooms.run(u, 'join', { code: 'ZZZZZZ', nickname: 'U' }))).code, 'ROOM_NOT_FOUND');
    const [{ n }] = await sql`select count(*)::int as n from private.rate_limit_hits where user_id = ${u} and action = 'join'`;
    assert.equal(n, 1);
    for (let i = 0; i < 19; i++) await err(rooms.run(u, 'join', { code: 'ZZZZZZ', nickname: 'U' }));
    assert.equal((await err(rooms.run(u, 'join', { code: 'ZZZZZZ', nickname: 'U' }))).code, 'RATE_LIMITED');
    await sql`update private.rate_limit_hits set created_at = now() - interval '601 seconds' where user_id = ${u}`;
    assert.equal((await err(rooms.run(u, 'join', { code: 'ZZZZZZ', nickname: 'U' }))).code, 'ROOM_NOT_FOUND');

    for (let i = 0; i < 10; i++) await ok(rooms.run(v, 'create', { nickname: 'V' }));
    assert.equal((await err(rooms.run(v, 'create', { nickname: 'V' }))).code, 'RATE_LIMITED');
    await sql`update private.rate_limit_hits set created_at = now() - interval '3601 seconds' where user_id = ${v}`;
    await ok(rooms.run(v, 'create', { nickname: 'V' }));
  });

  it('a code already used by an active room is retried, using the partial unique index', async () => {
    const [u, v] = await newUsers(2);
    const first = await ok(rooms.run(u, 'create', { nickname: 'U' }));
    const codes = [first.code, first.code, 'QWERTY'];
    await sql`update public.rooms set status = 'finished' where code = 'QWERTY' and status in ('lobby', 'playing')`;
    const retrying = createRoomsService({ repo: createPostgresRoomsRepo(sql), randomCode: () => codes.shift() });
    assert.equal((await ok(retrying.run(v, 'create', { nickname: 'V' }))).code, 'QWERTY');
  });

  it('a stale room version is never committed (I6): the action is rolled back and retried', async () => {
    const [host, b, c] = await newUsers(3);
    const r = await ok(rooms.run(host, 'create', { nickname: 'Host' }));
    const pg = createPostgresRoomsRepo(sql);
    let staleReads = 1;
    let transactions = 0;
    const staleRepo = {
      transaction: (fn) => pg.transaction((tx) => {
        transactions++;
        return fn({
          ...tx,
          async lockRooms(ids) {
            const locked = await tx.lockRooms(ids);
            return staleReads-- > 0 ? locked.map((x) => ({ ...x, version: x.version - 1 })) : locked;
          },
        });
      }),
    };
    const svc = createRoomsService({ repo: staleRepo });

    assert.deepEqual(await ok(svc.run(b, 'join', { code: r.code, nickname: 'B' })), { roomId: r.roomId, seat: 1 });
    assert.equal(transactions, 2);
    assert.equal((await room(r.roomId)).version, 1);
    const [{ n }] = await sql`select count(*)::int as n from private.rate_limit_hits where user_id = ${b}`;
    assert.equal(n, 1, 'the rolled-back attempt left no rate-limit hit');

    staleReads = Infinity;
    await assert.rejects(svc.run(c, 'join', { code: r.code, nickname: 'C' }), { name: 'RoomVersionConflictError' });
    assert.equal((await room(r.roomId)).version, 1);
    assert.deepEqual((await seats(r.roomId)).map(([id]) => id), [host, b]);
  });

  it('an unexpected database error rolls the whole action back', async () => {
    const [u] = await newUsers(1);
    const lobby = await ok(rooms.run(u, 'create', { nickname: 'U' }));
    const broken = createRoomsService({ repo: createPostgresRoomsRepo(sql), randomCode: () => 'bad!' });
    await assert.rejects(broken.run(u, 'create', { nickname: 'U' }), /rooms_code_check/);
    assert.equal((await room(lobby.roomId)).status, 'lobby');
    assert.deepEqual((await seats(lobby.roomId)).map(([id]) => id), [u]);
  });
});
