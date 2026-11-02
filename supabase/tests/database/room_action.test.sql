-- MIND-04 AC5 · load_room_for_action and commit_room_action: service-role only, compare-and-swap, consecutive seq.
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

insert into auth.users (id, is_anonymous) values
  ('f0000000-0000-4000-8000-000000000001', true),  -- host, seat 0
  ('f0000000-0000-4000-8000-000000000002', true),  -- guest, seat 1
  ('f0000000-0000-4000-8000-000000000003', true);  -- stranger
insert into public.rooms (id, code, host_id, status) values
  ('f1000000-0000-4000-8000-000000000001', 'ACTN23', 'f0000000-0000-4000-8000-000000000001', 'playing');
insert into public.room_players (room_id, user_id, seat, nickname, joined_at) values
  ('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002', 1, 'Guest', now() - interval '1 minute'),
  ('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 0, 'Host', now() - interval '2 minutes');

-- ---------------------------------------------------------------------------------------------------------
-- Privileges (I3)
-- ---------------------------------------------------------------------------------------------------------
select ok(
  (select bool_and(p.prosecdef) from pg_proc p where p.proname in ('load_room_for_action', 'commit_room_action') and p.pronamespace = 'public'::regnamespace),
  'both functions are security definer');
select ok(
  (select bool_and(p.proconfig @> array['search_path=""']) from pg_proc p where p.proname in ('load_room_for_action', 'commit_room_action') and p.pronamespace = 'public'::regnamespace),
  'both functions pin an empty search_path');
select ok(not has_function_privilege('authenticated', 'public.load_room_for_action(uuid, uuid)', 'execute'), 'authenticated cannot execute load_room_for_action');
select ok(not has_function_privilege('authenticated', 'public.commit_room_action(uuid, int, jsonb, jsonb, jsonb, jsonb, text, timestamptz, boolean)', 'execute'), 'authenticated cannot execute commit_room_action');
select ok(not has_function_privilege('anon', 'public.load_room_for_action(uuid, uuid)', 'execute'), 'anon cannot execute load_room_for_action');
select ok(not has_function_privilege('anon', 'public.commit_room_action(uuid, int, jsonb, jsonb, jsonb, jsonb, text, timestamptz, boolean)', 'execute'), 'anon cannot execute commit_room_action');
select ok(has_function_privilege('service_role', 'public.commit_room_action(uuid, int, jsonb, jsonb, jsonb, jsonb, text, timestamptz, boolean)', 'execute'), 'service_role can execute commit_room_action');

set local role authenticated;
set local request.jwt.claim.sub = 'f0000000-0000-4000-8000-000000000001';
select throws_ok($$select public.load_room_for_action('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001')$$,
  '42501', null, 'a signed-in member calling load_room_for_action is refused');
select throws_ok($$select public.commit_room_action('f1000000-0000-4000-8000-000000000001', 0, '{}', '[]', '[]', null, 'finished', null)$$,
  '42501', null, 'a signed-in member calling commit_room_action is refused');
reset role;
set local role anon;
select throws_ok($$select public.commit_room_action('f1000000-0000-4000-8000-000000000001', 0, '{}', '[]', '[]', null, 'finished', null)$$,
  '42501', null, 'anon calling commit_room_action is refused');
reset role;
select is((select version from public.rooms where id = 'f1000000-0000-4000-8000-000000000001'), 0, 'the refused calls changed nothing');

-- ---------------------------------------------------------------------------------------------------------
-- load_room_for_action
-- ---------------------------------------------------------------------------------------------------------
set local role service_role;
create temp table loaded as
  select public.load_room_for_action('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002') as member_view,
         public.load_room_for_action('f1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000003') as stranger_view,
         public.load_room_for_action('f1000000-0000-4000-8000-0000000000ff', 'f0000000-0000-4000-8000-000000000001') as missing,
         floor(extract(epoch from clock_timestamp()) * 1000)::bigint as now_ms;
select is((select (member_view->>'seat')::int from loaded), 1, 'load: the caller''s seat');
select is((select member_view->'seat' from loaded), '1'::jsonb, 'load: seat is a number');
select is((select stranger_view->'seat' from loaded), 'null'::jsonb, 'load: no seat for someone who is not seated');
select is((select missing from loaded), null::jsonb, 'load: null for a room that does not exist');
select is((select jsonb_path_query_array(member_view, '$.players[*].seat') from loaded), '[0, 1]'::jsonb, 'load: players in joined_at order');
select is((select member_view->'room'->>'status' from loaded), 'playing', 'load: the room');
select ok((select abs((member_view->>'nowMs')::bigint - now_ms) < 5000 from loaded), 'load: nowMs is the database clock in ms');

-- ---------------------------------------------------------------------------------------------------------
-- commit_room_action
-- ---------------------------------------------------------------------------------------------------------
select is(
  public.commit_room_action('f1000000-0000-4000-8000-000000000001', 0, '{"format":"mind-engine/1","rngState":1}',
    '[{"userId":"f0000000-0000-4000-8000-000000000001","hand":[{"v":11,"pile":"up"}]},{"userId":"f0000000-0000-4000-8000-000000000002","hand":[{"v":77,"pile":"up"}]}]',
    '[{"type":"levelStart","payload":{"level":1}},{"type":"syncStart","payload":{"reason":"level"}}]',
    '{"phase":"sync"}', 'playing', now() + interval '2 seconds', true),
  '{"conflict": false, "version": 1, "firstSeq": 1, "eventCount": 2}'::jsonb,
  'commit at the expected version: version 1, events from seq 1');

-- A stale version changes nothing at all.
select is(
  public.commit_room_action('f1000000-0000-4000-8000-000000000001', 0, '{"stale":true}',
    '[{"userId":"f0000000-0000-4000-8000-000000000001","hand":[]}]', '[{"type":"x","payload":{}}]', '{"phase":"stale"}', 'finished', null),
  '{"conflict": true}'::jsonb, 'a stale expected_version returns conflict');
select is((select version from public.rooms where id = 'f1000000-0000-4000-8000-000000000001'), 1, 'conflict: version unchanged');
select is((select status || ' ' || (public_state->>'phase') from public.rooms where id = 'f1000000-0000-4000-8000-000000000001'), 'playing sync', 'conflict: status and public_state unchanged');
select is((select engine_state from public.room_secrets where room_id = 'f1000000-0000-4000-8000-000000000001'), '{"format":"mind-engine/1","rngState":1}'::jsonb, 'conflict: engine state unchanged');
select is((select hand from public.room_hands where user_id = 'f0000000-0000-4000-8000-000000000001'), '[{"v":11,"pile":"up"}]'::jsonb, 'conflict: hands unchanged');
select is((select count(*) from public.room_events where room_id = 'f1000000-0000-4000-8000-000000000001'), 2::bigint, 'conflict: no event added');

-- Only the hands passed in change; they carry the new room version.
select is((public.commit_room_action('f1000000-0000-4000-8000-000000000001', 1, null,
    '[{"userId":"f0000000-0000-4000-8000-000000000002","hand":[]}]',
    '[{"type":"play","payload":{"playerId":"s1"}}]', '{"phase":"playing"}', null, null))->>'firstSeq', '3', 'the next commit continues at seq 3');
select results_eq(
  $$select user_id::text, hand, version from public.room_hands where room_id = 'f1000000-0000-4000-8000-000000000001' order by user_id$$,
  $$values ('f0000000-0000-4000-8000-000000000001', '[{"v":11,"pile":"up"}]'::jsonb, 1),
           ('f0000000-0000-4000-8000-000000000002', '[]'::jsonb, 2)$$,
  'only the changed hand is written, with the new version');

-- An event appended by the rooms function in between keeps the numbering consecutive.
insert into public.room_events (room_id, seq, type, payload) values ('f1000000-0000-4000-8000-000000000001', 4, 'gameAborted', '{"by":"s1","reason":"left"}');
select public.commit_room_action('f1000000-0000-4000-8000-000000000001', 2, null, '[]', '[]', '{"phase":"playing"}', null, null);
select public.commit_room_action('f1000000-0000-4000-8000-000000000001', 3, null, '[]',
  '[{"type":"a","payload":{}},{"type":"b","payload":{}},{"type":"c"}]', '{"phase":"playing"}', null, null);
select results_eq(
  $$select seq from public.room_events where room_id = 'f1000000-0000-4000-8000-000000000001' order by seq$$,
  $$select generate_series(1, 7)$$,
  'seq stays consecutive with no gaps across commits');

-- A hand for someone who is not seated fails, and the whole commit rolls back.
select throws_ok($$select public.commit_room_action('f1000000-0000-4000-8000-000000000001', 4, '{"bad":true}',
    '[{"userId":"f0000000-0000-4000-8000-000000000003","hand":[]}]', '[]', null, 'finished', null)$$,
  '23503', null, 'a hand row needs a seated player');
select is((select version || ' ' || status from public.rooms where id = 'f1000000-0000-4000-8000-000000000001'), '4 playing', 'the failed commit changed nothing');

-- clear_game (rematch): engine state and every hand are deleted.
select public.commit_room_action('f1000000-0000-4000-8000-000000000001', 4, null, '[]', '[{"type":"rematch","payload":{"by":"s0"}}]', null, 'lobby', null, true);
select ok(
  not exists (select 1 from public.room_secrets where room_id = 'f1000000-0000-4000-8000-000000000001')
  and not exists (select 1 from public.room_hands where room_id = 'f1000000-0000-4000-8000-000000000001')
  and (select status = 'lobby' and public_state is null and next_deadline_at is null from public.rooms where id = 'f1000000-0000-4000-8000-000000000001'),
  'clear_game removes the engine state and the hands and reopens the lobby');
reset role;

select * from finish();
rollback;
