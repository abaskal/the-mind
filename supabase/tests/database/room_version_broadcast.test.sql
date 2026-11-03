-- MIND-06 · Every room version change is broadcast on the room's private channel as {"v": version}, nothing more.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- realtime.messages is partitioned by day, and only the Realtime service (which owns the table) creates partitions.
do $$
begin
  insert into realtime.messages (topic, extension) values ('mind:partition-probe', 'presence');
exception when check_violation then
  raise exception 'realtime.messages has no partition for today: start the local stack with Realtime (npm run db:start)';
end;
$$;

insert into auth.users (id, is_anonymous, created_at) values ('e0000000-0000-4000-8000-000000000001', true, now());
insert into public.rooms (id, code, host_id, status) values
  ('f0000000-0000-4000-8000-000000000001', 'VERSNA', 'e0000000-0000-4000-8000-000000000001', 'playing');

create function pg_temp.sent() returns setof realtime.messages
language sql
as $$
  select * from realtime.messages
  where topic = 'room:f0000000-0000-4000-8000-000000000001' and extension = 'broadcast'
  order by inserted_at, id;
$$;

select is((select count(*) from pg_temp.sent()), 0::bigint, 'nothing is sent when a room is created');

update public.rooms set version = version + 1, public_state = '{"phase":"sync","players":[{"id":"s0","hand":[1,2]}]}'
 where id = 'f0000000-0000-4000-8000-000000000001';
select is((select count(*) from pg_temp.sent()), 1::bigint, 'a version change sends one message');
select is((select event from pg_temp.sent()), 'version', 'event `version`');
select is((select private from pg_temp.sent()), true, 'on the private channel only members can join');
select is((select payload - 'id' from pg_temp.sent()), '{"v": 1}'::jsonb, 'the payload is the version number only (no state, no hand)');

update public.rooms set last_activity_at = now() where id = 'f0000000-0000-4000-8000-000000000001';
update public.rooms set version = version where id = 'f0000000-0000-4000-8000-000000000001';
select is((select count(*) from pg_temp.sent()), 1::bigint, 'no message when the version does not change');

update public.rooms set version = version + 1, status = 'finished' where id = 'f0000000-0000-4000-8000-000000000001';
select is((select array_agg((payload->>'v')::int order by inserted_at, id) from pg_temp.sent()), array[1, 2], 'one message per version');

select ok(
  (select prosecdef from pg_proc where oid = 'private.broadcast_room_version()'::regprocedure),
  'the trigger function runs with its owner''s rights, whoever writes the room');
select ok(
  not has_function_privilege('authenticated', 'private.broadcast_room_version()', 'execute'),
  'clients cannot call it');

select * from finish();
rollback;
