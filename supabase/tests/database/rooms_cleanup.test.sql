-- MIND-03 AC5 · The cleanup job: defined in the migration, its SQL logic tested with backdated rooms and users.
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

select is(
  (select schedule || ' | ' || command from cron.job where jobname = 'the-mind-cleanup-rooms'),
  '*/10 * * * * | select private.cleanup_rooms()',
  'pg_cron runs private.cleanup_rooms() every 10 minutes'
);

insert into auth.users (id, is_anonymous, created_at) values
  ('c0000000-0000-4000-8000-000000000001', false, now()),                     -- host of every room
  ('c0000000-0000-4000-8000-000000000002', true, now() - interval '31 days'), -- old, no seat → deleted
  ('c0000000-0000-4000-8000-000000000003', true, now() - interval '31 days'), -- old, seated in an active lobby → kept
  ('c0000000-0000-4000-8000-000000000004', true, now() - interval '31 days'), -- old, seated only in an idle lobby → deleted
  ('c0000000-0000-4000-8000-000000000005', true, now() - interval '29 days'), -- young → kept
  ('c0000000-0000-4000-8000-000000000006', false, now() - interval '400 days'), -- not anonymous → kept
  ('c0000000-0000-4000-8000-000000000007', true, now() - interval '31 days'); -- old, left a playing room → deleted

insert into public.rooms (id, code, host_id, status, last_activity_at) values
  ('d0000000-0000-4000-8000-000000000001', 'LBYNEW', 'c0000000-0000-4000-8000-000000000001', 'lobby', now() - interval '29 minutes'),
  ('d0000000-0000-4000-8000-000000000002', 'LBYLTE', 'c0000000-0000-4000-8000-000000000001', 'lobby', now() - interval '31 minutes'),
  ('d0000000-0000-4000-8000-000000000003', 'PLYNEW', 'c0000000-0000-4000-8000-000000000001', 'playing', now() - interval '119 minutes'),
  ('d0000000-0000-4000-8000-000000000004', 'PLYLTE', 'c0000000-0000-4000-8000-000000000001', 'playing', now() - interval '121 minutes'),
  ('d0000000-0000-4000-8000-000000000005', 'FNSHNW', 'c0000000-0000-4000-8000-000000000001', 'finished', now() - interval '23 hours'),
  ('d0000000-0000-4000-8000-000000000006', 'FNSHLT', 'c0000000-0000-4000-8000-000000000001', 'finished', now() - interval '25 hours'),
  ('d0000000-0000-4000-8000-000000000007', 'ABNDLT', 'c0000000-0000-4000-8000-000000000001', 'abandoned', now() - interval '25 hours'),
  ('d0000000-0000-4000-8000-000000000008', 'LBYDAY', 'c0000000-0000-4000-8000-000000000001', 'lobby', now() - interval '25 hours');

insert into public.room_players (room_id, user_id, seat, nickname, left_at) values
  ('d0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000003', 1, 'Kept', null),
  ('d0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000004', 1, 'Idle', null),
  ('d0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000007', 1, 'Left', now());
insert into public.room_events (room_id, seq, type, payload) values
  ('d0000000-0000-4000-8000-000000000006', 1, 'gameOver', '{}');
insert into public.room_secrets (room_id, engine_state) values ('d0000000-0000-4000-8000-000000000006', '{}');
insert into private.rate_limit_hits (user_id, action, created_at) values
  ('c0000000-0000-4000-8000-000000000001', 'join', now() - interval '25 hours'),
  ('c0000000-0000-4000-8000-000000000001', 'join', now() - interval '1 hour');

create temp table cleanup_result as select private.cleanup_rooms() as r;

select is((select status from public.rooms where code = 'LBYNEW'), 'lobby', 'lobby idle 29 min stays a lobby');
select is((select status from public.rooms where code = 'LBYLTE'), 'abandoned', 'lobby idle 31 min becomes abandoned');
select is((select status from public.rooms where code = 'PLYNEW'), 'playing', 'game idle 1 h 59 min keeps playing');
select is((select status from public.rooms where code = 'PLYLTE'), 'abandoned', 'game idle 2 h 1 min becomes abandoned');
select is((select status from public.rooms where code = 'FNSHNW'), 'finished', 'finished room idle 23 h is kept');
select ok(not exists (select 1 from public.rooms where code in ('FNSHLT', 'ABNDLT', 'LBYDAY')),
  'rooms idle more than 24 h are deleted, whatever their status');
select ok(not exists (select 1 from public.room_events where room_id = 'd0000000-0000-4000-8000-000000000006')
  and not exists (select 1 from public.room_secrets where room_id = 'd0000000-0000-4000-8000-000000000006'),
  'deleting a room cascades to its events and secrets');
select ok(
  (select version from public.rooms where code = 'LBYLTE') = 1 and (select version from public.rooms where code = 'LBYNEW') = 0,
  'abandoning bumps the room version; untouched rooms keep theirs');
select ok((select last_activity_at from public.rooms where code = 'LBYLTE') < now() - interval '30 minutes',
  'abandoning does not count as activity');

select ok(not exists (select 1 from auth.users where id = 'c0000000-0000-4000-8000-000000000002'),
  'anonymous user older than 30 days with no seat is deleted');
select ok(exists (select 1 from auth.users where id = 'c0000000-0000-4000-8000-000000000003'),
  'anonymous user older than 30 days seated in an active room is kept');
select ok(not exists (select 1 from auth.users where id = 'c0000000-0000-4000-8000-000000000004'),
  'anonymous user whose only room was just abandoned is deleted');
select ok(not exists (select 1 from auth.users where id = 'c0000000-0000-4000-8000-000000000007'),
  'anonymous user who left their game is deleted');
select ok(exists (select 1 from auth.users where id = 'c0000000-0000-4000-8000-000000000005'),
  'anonymous user younger than 30 days is kept');
select ok(exists (select 1 from auth.users where id = 'c0000000-0000-4000-8000-000000000006'),
  'non-anonymous users are never deleted');
select is((select count(*) from private.rate_limit_hits where user_id = 'c0000000-0000-4000-8000-000000000001'), 1::bigint,
  'rate-limit hits older than a day are deleted');

select ok((select (r->>'lobbyAbandoned')::int >= 1 and (r->>'playingAbandoned')::int >= 1
                  and (r->>'roomsDeleted')::int >= 3 and (r->>'usersDeleted')::int >= 3 from cleanup_result),
  'cleanup_rooms() reports what it did');

select lives_ok('select private.cleanup_rooms()', 'running the cleanup again is harmless');

select * from finish();
rollback;
