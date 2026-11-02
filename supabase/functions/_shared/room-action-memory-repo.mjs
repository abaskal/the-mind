/**
 * In-memory implementation of the room-action repository interface (see room-action.mjs), for Node tests.
 * Values are copied through JSON in and out, like a database would. A commit is atomic and compares the version.
 *   createMemoryRoomActionRepo({ now? }) → repo, plus:
 *     repo.addRoom({ id, hostId, variant?, status?, code?, players: [{ userId, seat, nickname }] })
 *     repo.room(id) → the stored room (engineState, hands, events, publicState, …) for assertions
 *     repo.stats → { loads, commits, conflicts }  (commits counts successful writes only)
 */
const copy = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));

export function createMemoryRoomActionRepo({ now = () => Date.now() } = {}) {
  const rooms = new Map();
  const stats = { loads: 0, commits: 0, conflicts: 0 };

  return {
    stats,
    addRoom({ id, hostId, variant = 'classic', status = 'lobby', code = 'ABCDEF', players }) {
      rooms.set(id, {
        id, code, hostId, variant, status, version: 0, publicState: null, nextDeadlineAt: null, engineState: null,
        players: players.map((p) => ({ userId: p.userId, seat: p.seat, nickname: p.nickname, leftAt: null })),
        hands: new Map(),
        events: [],
      });
      return rooms.get(id);
    },
    room: (id) => rooms.get(id),

    async loadRoomForAction(roomId, userId) {
      stats.loads++;
      const r = rooms.get(roomId);
      if (!r) return null;
      const seated = r.players.filter((p) => p.leftAt == null);
      const me = seated.find((p) => p.userId === userId);
      return copy({
        room: { id: r.id, code: r.code, hostId: r.hostId, variant: r.variant, status: r.status, version: r.version },
        version: r.version,
        seat: me ? me.seat : null,
        players: seated.map((p) => ({ userId: p.userId, seat: p.seat, nickname: p.nickname })),
        engineState: r.engineState,
        nowMs: now(),
      });
    },

    async commitRoomAction(c) {
      const r = rooms.get(c.roomId);
      if (!r || r.version !== c.expectedVersion) {
        stats.conflicts++;
        return { conflict: true };
      }
      for (const h of c.hands || []) {
        if (!r.players.some((p) => p.userId === h.userId)) throw new Error(`hand for a user who is not seated: ${h.userId}`);
      }
      stats.commits++;
      r.version++;
      if (c.status) r.status = c.status;
      r.publicState = copy(c.publicState);
      r.nextDeadlineAt = c.nextDeadlineAt == null ? null : c.nextDeadlineAt;
      if (c.clearGame) {
        r.engineState = null;
        r.hands.clear();
      }
      if (c.engineState != null) r.engineState = copy(c.engineState);
      for (const h of c.hands || []) r.hands.set(h.userId, { hand: copy(h.hand), version: r.version });
      const firstSeq = r.events.length + 1;
      for (const e of c.events || []) r.events.push({ seq: r.events.length + 1, type: e.type, payload: copy(e.payload) });
      return { conflict: false, version: r.version, firstSeq };
    },
  };
}
