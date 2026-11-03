-- MIND-06 · A fast "the table changed" signal for the online table.
-- Realtime's Postgres Changes are polled, and the poller backs off while a table is quiet: after a silence (the whole
-- point of The Mind) other players learned of a play up to ~1.5 s late. Broadcast from Database streams instead.
-- Every version change of a room now sends {"v": <version>} as the Broadcast event `version` on the room's private
-- channel `room:<roomId>`. Clients then read what changed through RLS, as before.
--   * Only the version number is sent: no game state, no hand (I2).
--   * Only members receive it (the SELECT policy of 20261102300000_room_channel.sql). Clients still cannot send
--     Broadcast messages (I3); this trigger runs inside the server's own writes.
--   * realtime.send() turns any error into a warning, so a Realtime problem can never fail a game commit.

create function private.broadcast_room_version() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.version is distinct from old.version then
    perform realtime.send(jsonb_build_object('v', new.version), 'version', 'room:' || new.id::text, true);
  end if;
  return null;
end;
$$;
revoke all on function private.broadcast_room_version() from public, anon, authenticated;

create trigger rooms_broadcast_version after update of version on public.rooms
  for each row execute function private.broadcast_room_version();
