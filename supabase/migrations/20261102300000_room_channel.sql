-- MIND-05 · Realtime Authorization for the lobby's private channel `room:<roomId>`.
-- Clients join it with `config: { private: true }`, so Realtime checks these policies on realtime.messages:
--   * SELECT: who may join the channel and receive its Presence (and Broadcast) messages;
--   * INSERT: who may track Presence on it.
-- Only current members of the room pass (private.is_room_member: seated and not left). Nobody may send Broadcast
-- messages on the channel: there is no chat (PRD §5), and game state reaches clients through Postgres Changes.

-- Members of the room named by a `room:<uuid>` topic. Any other topic is refused without an error.
create function private.is_room_channel_member(p_topic text) returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when p_topic ~ '^room:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then private.is_room_member(substr(p_topic, 6)::uuid)
    else false
  end;
$$;
revoke all on function private.is_room_channel_member(text) from public, anon, authenticated;
grant execute on function private.is_room_channel_member(text) to authenticated;

create policy "Room members can join their room channel" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension in ('presence', 'broadcast')
    and (select private.is_room_channel_member((select realtime.topic())))
  );

create policy "Room members can track presence on their room channel" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and (select private.is_room_channel_member((select realtime.topic())))
  );
