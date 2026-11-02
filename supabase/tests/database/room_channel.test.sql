-- MIND-05 AC5 · Realtime Authorization of the private lobby channel `room:<roomId>`.
-- Each check calls realtime.authorize(), the same function the Realtime server runs when a client joins a private
-- channel (read: broadcast, presence) and tracks Presence (write: presence).
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

-- realtime.messages is partitioned by day, and only the Realtime service (which owns the table) creates partitions.
do $$
begin
  insert into realtime.messages (topic, extension) values ('mind:partition-probe', 'presence');
exception when check_violation then
  raise exception 'realtime.messages has no partition for today: start the local stack with Realtime (npm run db:start)';
end;
$$;

insert into auth.users (id, is_anonymous, created_at) values
  ('c0000000-0000-4000-8000-000000000001', true, now()),  -- host of room 1
  ('c0000000-0000-4000-8000-000000000002', true, now()),  -- guest of room 1
  ('c0000000-0000-4000-8000-000000000003', true, now()),  -- signed in, not a member of room 1 (host of room 2)
  ('c0000000-0000-4000-8000-000000000004', true, now());  -- left room 2 during a game
insert into public.rooms (id, code, host_id, status) values
  ('d0000000-0000-4000-8000-000000000001', 'CHANAA', 'c0000000-0000-4000-8000-000000000001', 'lobby'),
  ('d0000000-0000-4000-8000-000000000002', 'CHANBB', 'c0000000-0000-4000-8000-000000000003', 'playing');
insert into public.room_players (room_id, user_id, seat, nickname, left_at) values
  ('d0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 0, 'Host', null),
  ('d0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 1, 'Guest', null),
  ('d0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000003', 0, 'Other', null),
  ('d0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000004', 1, 'Gone', now());

-- → '{read broadcast, read presence}|{write presence, write broadcast}', e.g. '{t,t}|{t,f}'.
create function pg_temp.channel_access(p_role text, p_user uuid, p_topic text) returns text
language sql
as $$
  select a.read_allowed::text || '|' || a.write_allowed::text
  from realtime.authorize(
    role_name => p_role,
    topic_name => p_topic,
    claims => json_build_object('sub', p_user, 'role', p_role, 'is_anonymous', true)::text,
    sub => coalesce(p_user::text, ''),
    headers => '{}',
    read_extensions => array['broadcast', 'presence'],
    write_extensions => array['presence', 'broadcast']
  ) a;
$$;

select is(
  pg_temp.channel_access('authenticated', 'c0000000-0000-4000-8000-000000000001', 'room:d0000000-0000-4000-8000-000000000001'),
  '{t,t}|{t,f}', 'host: can join the channel and track Presence, but not send Broadcast');
select is(
  pg_temp.channel_access('authenticated', 'c0000000-0000-4000-8000-000000000002', 'room:d0000000-0000-4000-8000-000000000001'),
  '{t,t}|{t,f}', 'guest: can join the channel and track Presence, but not send Broadcast');
select is(
  pg_temp.channel_access('authenticated', 'c0000000-0000-4000-8000-000000000003', 'room:d0000000-0000-4000-8000-000000000001'),
  '{f,f}|{f,f}', 'signed-in non-member: can neither join the channel nor track Presence');
select is(
  pg_temp.channel_access('authenticated', 'c0000000-0000-4000-8000-000000000001', 'room:d0000000-0000-4000-8000-000000000002'),
  '{f,f}|{f,f}', 'member of another room: is refused');
select is(
  pg_temp.channel_access('authenticated', 'c0000000-0000-4000-8000-000000000004', 'room:d0000000-0000-4000-8000-000000000002'),
  '{f,f}|{f,f}', 'player who left: is refused');
select is(
  pg_temp.channel_access('anon', null, 'room:d0000000-0000-4000-8000-000000000001'),
  '{f,f}|{f,f}', 'anon (not signed in): is refused');
select is(
  pg_temp.channel_access('authenticated', 'c0000000-0000-4000-8000-000000000001', 'room:not-a-room'),
  '{f,f}|{f,f}', 'malformed topic: is refused without an error');
select is(
  pg_temp.channel_access('authenticated', 'c0000000-0000-4000-8000-000000000001', 'room:D0000000-0000-4000-8000-000000000001'),
  '{f,f}|{f,f}', 'upper-case room id: is refused (the channel name uses the id as stored)');
select is(
  pg_temp.channel_access('authenticated', 'c0000000-0000-4000-8000-000000000001', 'lobby:d0000000-0000-4000-8000-000000000001'),
  '{f,f}|{f,f}', 'other topic prefix: is refused');

-- Membership is checked on every join: a lobby leaver is deleted (rooms → leave) and loses access at once.
delete from public.room_players
 where room_id = 'd0000000-0000-4000-8000-000000000001' and user_id = 'c0000000-0000-4000-8000-000000000002';
select is(
  pg_temp.channel_access('authenticated', 'c0000000-0000-4000-8000-000000000002', 'room:d0000000-0000-4000-8000-000000000001'),
  '{f,f}|{f,f}', 'guest after leaving the lobby: is refused');

select ok(
  (select prosecdef = false from pg_proc where oid = 'private.is_room_channel_member(text)'::regprocedure),
  'is_room_channel_member runs with the caller''s rights');
select ok(
  not has_function_privilege('anon', 'private.is_room_channel_member(text)', 'execute'),
  'anon cannot execute is_room_channel_member');
select ok(
  (select count(*) = 2 from pg_policy where polrelid = 'realtime.messages'::regclass and polname like 'Room members can %'),
  'realtime.messages has the two room channel policies');

select * from finish();
rollback;
