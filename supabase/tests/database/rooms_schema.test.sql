-- MIND-03 · Schema guarantees the rooms function relies on.
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

select tables_are('public', array['rooms', 'room_players', 'room_secrets', 'room_hands', 'room_events'], 'public has exactly the rooms tables');
select ok(
  not exists (select 1 from pg_class c where c.relkind = 'r' and c.relnamespace::regnamespace::text in ('public', 'private') and not c.relrowsecurity),
  'RLS is enabled on every table in public and private');
select is(
  (select count(*) from pg_policies where schemaname in ('public', 'private') and cmd <> 'SELECT'), 0::bigint,
  'there are no INSERT/UPDATE/DELETE/ALL policies');
select is(
  (select count(*) from pg_policies where schemaname in ('public', 'private') and tablename in ('room_secrets', 'rate_limit_hits')), 0::bigint,
  'room_secrets and rate_limit_hits have no policies at all');
select set_eq(
  $$select tablename::text from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'$$,
  array['rooms', 'room_players', 'room_events', 'room_hands'],
  'Realtime publishes rooms, room_players, room_events and room_hands, never room_secrets');

insert into auth.users (id, is_anonymous) values ('e0000000-0000-4000-8000-000000000001', true), ('e0000000-0000-4000-8000-000000000002', true);

-- Room codes
select lives_ok($$insert into public.rooms (code, host_id) values ('AB23XY', 'e0000000-0000-4000-8000-000000000001')$$, 'a valid code is accepted');
select throws_ok($$insert into public.rooms (code, host_id) values ('AB23XI', 'e0000000-0000-4000-8000-000000000001')$$, '23514', null, 'I is not in the code alphabet');
select throws_ok($$insert into public.rooms (code, host_id) values ('ab23xy', 'e0000000-0000-4000-8000-000000000001')$$, '23514', null, 'codes are stored upper case');
select throws_ok($$insert into public.rooms (code, host_id) values ('AB23X', 'e0000000-0000-4000-8000-000000000001')$$, '23514', null, 'codes have 6 characters');
select throws_ok($$insert into public.rooms (code, host_id) values ('AB23XY', 'e0000000-0000-4000-8000-000000000002')$$, '23505', null, 'two active rooms cannot share a code');
update public.rooms set status = 'finished' where code = 'AB23XY';
select lives_ok($$insert into public.rooms (code, host_id) values ('AB23XY', 'e0000000-0000-4000-8000-000000000002')$$, 'a finished room''s code can be reused');
select throws_ok($$insert into public.rooms (code, host_id, variant) values ('ZZ23XY', 'e0000000-0000-4000-8000-000000000001', 'extreme')$$, '23514', null, 'unknown variants are rejected');
select throws_ok($$insert into public.rooms (code, host_id, status) values ('ZZ23XY', 'e0000000-0000-4000-8000-000000000001', 'paused')$$, '23514', null, 'unknown statuses are rejected');

-- Players
select lives_ok($$insert into public.room_players (room_id, user_id, seat, nickname) select id, 'e0000000-0000-4000-8000-000000000001', 0, 'Ayşe' from public.rooms where code = 'AB23XY' and status = 'lobby'$$, 'a player takes a seat');
select throws_ok($$insert into public.room_players (room_id, user_id, seat, nickname) select id, 'e0000000-0000-4000-8000-000000000002', 0, 'Bora' from public.rooms where code = 'AB23XY' and status = 'lobby'$$, '23505', null, 'two active players cannot share a seat');
select throws_ok($$insert into public.room_players (room_id, user_id, seat, nickname) select id, 'e0000000-0000-4000-8000-000000000002', 4, 'Bora' from public.rooms where code = 'AB23XY' and status = 'lobby'$$, '23514', null, 'seats are 0–3');
select throws_ok($$insert into public.room_players (room_id, user_id, seat, nickname) select id, 'e0000000-0000-4000-8000-000000000002', 1, repeat('x', 17) from public.rooms where code = 'AB23XY' and status = 'lobby'$$, '23514', null, 'nicknames have at most 16 characters');
select throws_ok($$insert into public.room_players (room_id, user_id, seat, nickname) select id, 'e0000000-0000-4000-8000-000000000002', 1, 'Cafe' || chr(769) from public.rooms where code = 'AB23XY' and status = 'lobby'$$, '23514', null, 'nicknames are stored NFC-normalized');

-- Hands belong to seated players
select throws_ok($$insert into public.room_hands (room_id, user_id, hand, version) select id, 'e0000000-0000-4000-8000-000000000002', '[1]', 1 from public.rooms where code = 'AB23XY' and status = 'lobby'$$, '23503', null, 'a hand needs a seated player');
select lives_ok($$update public.rooms set version = version + 1 where code = 'AB23XY' and status = 'lobby'$$, 'updated_at is maintained by a trigger');

select * from finish();
rollback;
