-- MIND-04 · Gameplay: the two database calls of the `room-action` Edge Function.
-- Only the service role may execute them (I3). Each call is one transaction. A commit is a compare-and-swap on
-- rooms.version (I6), and clock_timestamp() is the single game clock.

-- The room, the caller's seat (null when they are not seated), the seated players in joined_at order, the hidden
-- engine state and the server time in ms. One statement, so it is one consistent snapshot. Returns null when the
-- room does not exist. Reads only: concurrent actions are resolved by the CAS in commit_room_action.
create function public.load_room_for_action(p_room_id uuid, p_user_id uuid) returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'room', jsonb_build_object(
      'id', r.id, 'code', r.code, 'hostId', r.host_id, 'variant', r.variant, 'status', r.status, 'version', r.version
    ),
    'version', r.version,
    'seat', (
      select p.seat from public.room_players p
      where p.room_id = r.id and p.user_id = p_user_id and p.left_at is null
    ),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('userId', p.user_id, 'seat', p.seat, 'nickname', p.nickname)
                       order by p.joined_at, p.seat)
      from public.room_players p
      where p.room_id = r.id and p.left_at is null
    ), '[]'::jsonb),
    'engineState', (select s.engine_state from public.room_secrets s where s.room_id = r.id),
    'nowMs', floor(extract(epoch from clock_timestamp()) * 1000)::bigint
  )
  from public.rooms r
  where r.id = p_room_id;
$$;

-- Commits one action atomically, or returns {"conflict": true} and changes nothing when the room's version is no
-- longer p_expected_version.
--   p_engine_state     full engine state (room_secrets); null keeps the stored one
--   p_hands            [{ "userId", "hand" }] – only the hands that changed
--   p_events           [{ "type", "payload" }] in order; payloads are already the public redaction
--   p_public_state     rooms.public_state (replaced, null clears it)
--   p_status           new rooms.status, or null to keep it
--   p_next_deadline_at rooms.next_deadline_at (replaced)
--   p_clear_game       delete the engine state and every hand first (start, rematch)
-- → { "conflict": false, "version", "firstSeq", "eventCount" }
create function public.commit_room_action(
  p_room_id uuid,
  p_expected_version int,
  p_engine_state jsonb,
  p_hands jsonb,
  p_events jsonb,
  p_public_state jsonb,
  p_status text,
  p_next_deadline_at timestamptz,
  p_clear_game boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version int;
  v_last_seq int;
  v_event_count int;
begin
  -- 1. Compare-and-swap. The row lock it takes also serializes the seq numbers below.
  update public.rooms
     set version = version + 1,
         status = coalesce(p_status, status),
         public_state = p_public_state,
         next_deadline_at = p_next_deadline_at,
         last_activity_at = now()
   where id = p_room_id and version = p_expected_version
  returning version into v_version;
  if not found then
    return jsonb_build_object('conflict', true);
  end if;

  if p_clear_game then
    delete from public.room_secrets where room_id = p_room_id;
    delete from public.room_hands where room_id = p_room_id;
  end if;

  -- 2. The hidden engine state.
  if p_engine_state is not null then
    insert into public.room_secrets (room_id, engine_state) values (p_room_id, p_engine_state)
    on conflict (room_id) do update set engine_state = excluded.engine_state;
  end if;

  -- 3. Only the hands that changed.
  insert into public.room_hands (room_id, user_id, hand, version)
  select p_room_id, (h.value->>'userId')::uuid, h.value->'hand', v_version
  from jsonb_array_elements(coalesce(p_hands, '[]'::jsonb)) as h(value)
  on conflict (room_id, user_id) do update set hand = excluded.hand, version = excluded.version, updated_at = now();

  -- 4. Events with consecutive seq.
  select coalesce(max(seq), 0) into v_last_seq from public.room_events where room_id = p_room_id;
  insert into public.room_events (room_id, seq, type, payload)
  select p_room_id, v_last_seq + e.ord, e.value->>'type', coalesce(e.value->'payload', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) with ordinality as e(value, ord);
  get diagnostics v_event_count = row_count;

  return jsonb_build_object(
    'conflict', false, 'version', v_version, 'firstSeq', v_last_seq + 1, 'eventCount', v_event_count
  );
end;
$$;

revoke all on function public.load_room_for_action(uuid, uuid) from public, anon, authenticated;
revoke all on function public.commit_room_action(uuid, int, jsonb, jsonb, jsonb, jsonb, text, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.load_room_for_action(uuid, uuid) to service_role;
grant execute on function public.commit_room_action(uuid, int, jsonb, jsonb, jsonb, jsonb, text, timestamptz, boolean)
  to service_role;
