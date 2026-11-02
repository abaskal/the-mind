/**
 * In-memory implementation of the rooms repository interface (see rooms-rules.mjs), for Node tests and local
 * experiments. Transactions run one at a time and roll back when the callback throws.
 *   createMemoryRoomsRepo({ now? }) → repo, plus repo.state for assertions and repo.setRoomStatus for test setup
 */
import { RoomVersionConflictError } from './rooms-rules.mjs';

export function createMemoryRoomsRepo({ now = () => Date.now() } = {}) {
  let state = { rooms: [], players: [], events: [], hits: [], nextId: 1 };
  let queue = Promise.resolve();

  const newId = () => {
    const n = String(state.nextId++).padStart(12, '0');
    return `00000000-0000-4000-8000-${n}`;
  };
  const room = (id) => state.rooms.find((r) => r.id === id) || null;
  const copy = (x) => (x ? { ...x } : x);
  const active = (p) => p.leftAt == null;

  const tx = {
    async lockUser() {},
    async countRateLimitHits(userId, action, windowSeconds) {
      const since = now() - windowSeconds * 1000;
      return state.hits.filter((h) => h.userId === userId && h.action === action && h.at > since).length;
    },
    async recordRateLimitHit(userId, action) {
      state.hits.push({ userId, action, at: now() });
    },
    async findActiveSeat(userId) {
      const seat = state.players
        .filter((p) => p.userId === userId && active(p))
        .map((p) => ({ p, r: room(p.roomId) }))
        .filter(({ r }) => r && (r.status === 'lobby' || r.status === 'playing'))
        .sort((a, b) => b.p.joinedAt - a.p.joinedAt)[0];
      return seat ? { roomId: seat.r.id, seat: seat.p.seat, status: seat.r.status } : null;
    },
    async findActiveRoomByCode(code) {
      return copy(state.rooms.find((r) => r.code === code && (r.status === 'lobby' || r.status === 'playing')));
    },
    async lockRooms(ids) {
      return [...new Set(ids)].sort().map(room).filter(Boolean).map(copy);
    },
    async getActivePlayer(roomId, userId) {
      return copy(state.players.find((p) => p.roomId === roomId && p.userId === userId && active(p)));
    },
    async listActivePlayers(roomId) {
      return state.players
        .filter((p) => p.roomId === roomId && active(p))
        .sort((a, b) => a.joinedAt - b.joinedAt || a.order - b.order)
        .map(copy);
    },
    async insertRoom({ code, hostId, variant }) {
      if (state.rooms.some((r) => r.code === code && (r.status === 'lobby' || r.status === 'playing'))) return null;
      const r = { id: newId(), code, hostId, variant, status: 'lobby', version: 0, lastActivityAt: now() };
      state.rooms.push(r);
      return copy(r);
    },
    async insertPlayer({ roomId, userId, seat, nickname }) {
      const old = state.players.find((p) => p.roomId === roomId && p.userId === userId);
      if (old && active(old)) throw new Error('duplicate player');
      if (state.players.some((p) => p.roomId === roomId && p.seat === seat && active(p))) throw new Error('seat taken');
      state.players = state.players.filter((p) => p !== old);
      state.players.push({ roomId, userId, seat, nickname, joinedAt: now(), order: state.nextId++, leftAt: null });
    },
    async deletePlayer(roomId, userId) {
      state.players = state.players.filter((p) => !(p.roomId === roomId && p.userId === userId));
    },
    async markPlayerLeft(roomId, userId) {
      const p = state.players.find((x) => x.roomId === roomId && x.userId === userId);
      if (p) p.leftAt = now();
    },
    async updateRoom(expected, patch) {
      const r = room(expected.id);
      if (!r || r.version !== expected.version) throw new RoomVersionConflictError(expected.id);
      for (const k of ['hostId', 'variant', 'status']) if (patch[k] !== undefined) r[k] = patch[k];
      r.version++;
      r.lastActivityAt = now();
      return copy(r);
    },
    async appendEvent(roomId, type, payload) {
      const seq = state.events.filter((e) => e.roomId === roomId).length + 1;
      state.events.push({ roomId, seq, type, payload: JSON.parse(JSON.stringify(payload)) });
      return seq;
    },
  };

  return {
    get state() { return state; },
    transaction(fn) {
      const run = queue.then(async () => {
        const before = structuredClone(state);
        try {
          return await fn(tx);
        } catch (err) {
          state = before;
          throw err;
        }
      });
      queue = run.catch(() => {});
      return run;
    },
    setRoomStatus(roomId, status) {
      room(roomId).status = status;
    },
  };
}
