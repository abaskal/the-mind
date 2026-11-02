-- MIND-03 AC2 · Row-level security and privileges for the rooms tables.
begin;
create extension if not exists pgtap with schema extensions;
select plan(60);

-- Fixtures (as postgres): a lobby room with host + guest, a stranger, and one row in every table.
insert into auth.users (id, is_anonymous, created_at) values
  ('a0000000-0000-4000-8000-000000000001', true, now()),  -- host (member)
  ('a0000000-0000-4000-8000-000000000002', true, now()),  -- guest (member)
  ('a0000000-0000-4000-8000-000000000003', true, now()),  -- stranger (not a member)
  ('a0000000-0000-4000-8000-000000000004', true, now());  -- left the room
insert into public.rooms (id, code, host_id) values
  ('b0000000-0000-4000-8000-000000000001', 'RLSTST', 'a0000000-0000-4000-8000-000000000001');
insert into public.room_players (room_id, user_id, seat, nickname, left_at) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 0, 'Host', null),
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 1, 'Guest', null),
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000004', 2, 'Gone', now());
insert into public.room_events (room_id, seq, type, payload) values
  ('b0000000-0000-4000-8000-000000000001', 1, 'gameAborted', '{"by":"x"}');
insert into public.room_hands (room_id, user_id, hand, version) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '[11, 42]', 1),
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', '[77]', 1);
insert into public.room_secrets (room_id, engine_state) values
  ('b0000000-0000-4000-8000-000000000001', '{"players":[{"hand":[11,42]},{"hand":[77]}]}');
insert into private.rate_limit_hits (user_id, action) values ('a0000000-0000-4000-8000-000000000002', 'join');

-- Statements every client role must be refused (no INSERT/UPDATE/DELETE/TRUNCATE privilege, I3).
create temp table write_attempts (q text) on commit drop;
insert into write_attempts values
  ($$insert into public.rooms (code, host_id) values ('ZZZZZZ', 'a0000000-0000-4000-8000-000000000001')$$),
  ($$update public.rooms set status = 'finished'$$),
  ($$delete from public.rooms$$),
  ($$insert into public.room_players (room_id, user_id, seat, nickname) values ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', 3, 'Me')$$),
  ($$update public.room_players set seat = 3$$),
  ($$delete from public.room_players$$),
  ($$insert into public.room_events (room_id, seq, type, payload) values ('b0000000-0000-4000-8000-000000000001', 2, 'x', '{}')$$),
  ($$update public.room_events set payload = '{}'$$),
  ($$delete from public.room_events$$),
  ($$insert into public.room_hands (room_id, user_id, hand, version) values ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', '[1]', 1)$$),
  ($$update public.room_hands set hand = '[]'$$),
  ($$delete from public.room_hands$$),
  ($$insert into public.room_secrets (room_id, engine_state) values ('b0000000-0000-4000-8000-000000000001', '{}')$$),
  ($$update public.room_secrets set engine_state = '{}'$$),
  ($$delete from public.room_secrets$$),
  ($$insert into private.rate_limit_hits (user_id, action) values ('a0000000-0000-4000-8000-000000000001', 'join')$$),
  ($$update private.rate_limit_hits set action = 'x'$$),
  ($$delete from private.rate_limit_hits$$),
  ($$truncate public.rooms cascade$$),
  ($$truncate public.room_secrets$$);
grant select on write_attempts to anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- A stranger (signed in, not a member)
-- ---------------------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000003';

select is((select count(*) from public.rooms), 0::bigint, 'stranger: cannot select the room');
select is((select count(*) from public.room_players), 0::bigint, 'stranger: cannot select its players');
select is((select count(*) from public.room_events), 0::bigint, 'stranger: cannot select its events');
select is((select count(*) from public.room_hands), 0::bigint, 'stranger: cannot select any hand');

-- ---------------------------------------------------------------------------------------------------------
-- A player who has left the room is no longer a member
-- ---------------------------------------------------------------------------------------------------------
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000004';
select is((select count(*) from public.rooms), 0::bigint, 'player who left: cannot select the room any more');
select is((select count(*) from public.room_events), 0::bigint, 'player who left: cannot select its events any more');

-- ---------------------------------------------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------------------------------------------
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000001';

select is((select count(*) from public.rooms), 1::bigint, 'member: can select the room');
select is((select count(*) from public.room_players), 3::bigint, 'member: can select its players');
select is((select count(*) from public.room_events), 1::bigint, 'member: can select its events');
select results_eq(
  'select user_id, hand from public.room_hands',
  $$values ('a0000000-0000-4000-8000-000000000001'::uuid, '[11, 42]'::jsonb)$$,
  'host: selects only their own hand'
);

set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';
select results_eq(
  'select user_id, hand from public.room_hands',
  $$values ('a0000000-0000-4000-8000-000000000002'::uuid, '[77]'::jsonb)$$,
  'guest: selects only their own hand'
);
select is((select count(*) from public.room_hands where user_id <> 'a0000000-0000-4000-8000-000000000002'), 0::bigint,
  'guest: even filtering explicitly for another player''s hand returns nothing');

-- room_secrets holds every hand: no client role can read it at all (0 rows readable).
select throws_ok('select * from public.room_secrets', '42501', null, 'authenticated: room_secrets cannot be read');
select throws_ok('select * from private.rate_limit_hits', '42501', null, 'authenticated: rate limit hits cannot be read');
select throws_ok('select private.cleanup_rooms()', '42501', null, 'authenticated: cannot run the cleanup');

-- Every write, on every table, as a member of the room.
select throws_ok(q, '42501', null, 'authenticated member refused: ' || left(q, 70)) from write_attempts;

-- ---------------------------------------------------------------------------------------------------------
-- anon (no session)
-- ---------------------------------------------------------------------------------------------------------
reset role;
set local role anon;
set local request.jwt.claim.sub = '';

select throws_ok('select * from public.room_secrets', '42501', null, 'anon: room_secrets cannot be read');
select throws_ok('select * from public.rooms', '42501', null, 'anon: rooms cannot be read');
select throws_ok('select * from public.room_hands', '42501', null, 'anon: room_hands cannot be read');
select throws_ok('select private.is_room_member(''b0000000-0000-4000-8000-000000000001'')', '42501', null,
  'anon: cannot call the membership helper');
select throws_ok(q, '42501', null, 'anon refused: ' || left(q, 70)) from write_attempts;

reset role;
select is((select count(*) from public.room_secrets where room_id = 'b0000000-0000-4000-8000-000000000001'), 1::bigint,
  'the server role still sees the secret row');

select * from finish();
rollback;
