/**
 * room-action repository on Postgres, through the two service-role-only SQL functions of the MIND-04 migration
 * (load_room_for_action, commit_room_action), called over PostgREST RPC. `client` is a supabase-js client created
 * with the service-role key from the function's environment (I3). Runtime-agnostic: the caller creates the client.
 */
export function createRpcRoomActionRepo(client) {
  async function call(name, params) {
    const { data, error } = await client.rpc(name, params);
    if (error) throw new Error(`${name} failed: ${error.message}`);
    return data;
  }

  return {
    loadRoomForAction: (roomId, userId) => call('load_room_for_action', { p_room_id: roomId, p_user_id: userId }),

    commitRoomAction: (c) => call('commit_room_action', {
      p_room_id: c.roomId,
      p_expected_version: c.expectedVersion,
      p_engine_state: c.engineState ?? null,
      p_hands: c.hands ?? [],
      p_events: c.events ?? [],
      p_public_state: c.publicState ?? null,
      p_status: c.status ?? null,
      p_next_deadline_at: c.nextDeadlineAt == null ? null : new Date(c.nextDeadlineAt).toISOString(),
      p_clear_game: !!c.clearGame,
    }),
  };
}
