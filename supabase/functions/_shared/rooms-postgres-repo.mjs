/**
 * Postgres implementation of the rooms repository interface (see rooms-rules.mjs).
 * `sql` is a postgres.js client (https://github.com/porsager/postgres) connected as a server role. The caller
 * creates it, so this module stays runtime-agnostic (Deno Edge Function and Node integration tests).
 * Every timestamp comes from the Postgres clock (now()).
 */
import { RoomVersionConflictError } from './rooms-rules.mjs';

const USER_LOCK_NAMESPACE = 31003;

const toRoom = (r) => r && {
  id: r.id, code: r.code, hostId: r.host_id, variant: r.variant, status: r.status, version: r.version,
};
const toPlayer = (p) => p && {
  roomId: p.room_id, userId: p.user_id, seat: p.seat, nickname: p.nickname, joinedAt: p.joined_at,
};

function wrap(sql) {
  return {
    async lockUser(userId) {
      await sql`select pg_advisory_xact_lock(${USER_LOCK_NAMESPACE}, hashtext(${userId}::text))`;
    },
    async countRateLimitHits(userId, action, windowSeconds) {
      const [row] = await sql`
        select count(*)::int as n from private.rate_limit_hits
        where user_id = ${userId} and action = ${action}
          and created_at > now() - make_interval(secs => ${windowSeconds})`;
      return row.n;
    },
    async recordRateLimitHit(userId, action) {
      await sql`insert into private.rate_limit_hits (user_id, action) values (${userId}, ${action})`;
    },
    async findActiveSeat(userId) {
      const [row] = await sql`
        select p.room_id, p.seat, r.status
        from public.room_players p join public.rooms r on r.id = p.room_id
        where p.user_id = ${userId} and p.left_at is null and r.status in ('lobby', 'playing')
        order by p.joined_at desc
        limit 1`;
      return row ? { roomId: row.room_id, seat: row.seat, status: row.status } : null;
    },
    async findActiveRoomByCode(code) {
      const [row] = await sql`select * from public.rooms where code = ${code} and status in ('lobby', 'playing')`;
      return toRoom(row) || null;
    },
    async lockRooms(ids) {
      const unique = [...new Set(ids)];
      if (!unique.length) return [];
      const rows = await sql`select * from public.rooms where id = any(${unique}::uuid[]) order by id for update`;
      return rows.map(toRoom);
    },
    async getActivePlayer(roomId, userId) {
      const [row] = await sql`
        select * from public.room_players where room_id = ${roomId} and user_id = ${userId} and left_at is null`;
      return toPlayer(row) || null;
    },
    async listActivePlayers(roomId) {
      const rows = await sql`
        select * from public.room_players where room_id = ${roomId} and left_at is null order by joined_at, seat`;
      return rows.map(toPlayer);
    },
    async insertRoom({ code, hostId, variant }) {
      const [row] = await sql`
        insert into public.rooms (code, host_id, variant) values (${code}, ${hostId}, ${variant})
        on conflict (code) where status in ('lobby', 'playing') do nothing
        returning *`;
      return toRoom(row) || null;
    },
    async insertPlayer({ roomId, userId, seat, nickname }) {
      // A row left behind by an earlier stay in this room (left_at set) is reused for the new seat.
      const [row] = await sql`
        insert into public.room_players (room_id, user_id, seat, nickname)
        values (${roomId}, ${userId}, ${seat}, ${nickname})
        on conflict (room_id, user_id) do update
          set seat = excluded.seat, nickname = excluded.nickname, joined_at = now(), left_at = null
          where public.room_players.left_at is not null
        returning user_id`;
      if (!row) throw new Error('duplicate player');
    },
    async deletePlayer(roomId, userId) {
      await sql`delete from public.room_players where room_id = ${roomId} and user_id = ${userId}`;
    },
    async markPlayerLeft(roomId, userId) {
      await sql`update public.room_players set left_at = now() where room_id = ${roomId} and user_id = ${userId}`;
    },
    async updateRoom(expected, patch) {
      // Compare-and-swap (I6): the row lock taken by lockRooms makes a conflict unlikely, the version check makes
      // it impossible to commit over a change this transaction has not seen.
      const [row] = await sql`
        update public.rooms set
          host_id = coalesce(${patch.hostId ?? null}::uuid, host_id),
          variant = coalesce(${patch.variant ?? null}::text, variant),
          status = coalesce(${patch.status ?? null}::text, status),
          version = version + 1,
          last_activity_at = now()
        where id = ${expected.id} and version = ${expected.version}
        returning *`;
      if (!row) throw new RoomVersionConflictError(expected.id);
      return toRoom(row);
    },
    async appendEvent(roomId, type, payload) {
      // Callers hold the room's row lock, so max(seq) + 1 cannot race.
      const [row] = await sql`
        insert into public.room_events (room_id, seq, type, payload)
        select ${roomId}, coalesce(max(seq), 0) + 1, ${type}, ${sql.json(payload)}
        from public.room_events where room_id = ${roomId}
        returning seq`;
      return row.seq;
    },
  };
}

export function createPostgresRoomsRepo(sql) {
  return {
    transaction: (fn) => sql.begin((tx) => fn(wrap(tx))),
  };
}
