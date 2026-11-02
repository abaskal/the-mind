-- MIND-03 · Rooms lobby backend.
-- Clients only ever READ (row-level security below). Every write goes through the `rooms` Edge Function,
-- which connects as a server role (I3). Times always come from the Postgres clock (I6).

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------

create table public.rooms (
  id               uuid primary key default gen_random_uuid(),
  code             text not null check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  host_id          uuid not null references auth.users (id) on delete cascade,
  variant          text not null default 'classic' check (variant in ('classic', 'reverse', 'blind', 'dual')),
  status           text not null default 'lobby' check (status in ('lobby', 'playing', 'finished', 'abandoned')),
  version          int not null default 0,
  public_state     jsonb,
  next_deadline_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_activity_at timestamptz not null default now()
);
comment on table public.rooms is 'One game table. Members can read it; only the server-side Edge Functions write it.';

-- A code is unique among active rooms only, so codes of finished rooms can be reused.
create unique index rooms_active_code_key on public.rooms (code) where status in ('lobby', 'playing');
create index rooms_host_id_idx on public.rooms (host_id);
create index rooms_status_activity_idx on public.rooms (status, last_activity_at);

create table public.room_players (
  room_id   uuid not null references public.rooms (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  seat      smallint not null check (seat between 0 and 3),
  nickname  text not null check (char_length(nickname) between 1 and 16 and nickname is nfc normalized),
  joined_at timestamptz not null default now(),
  left_at   timestamptz,
  primary key (room_id, user_id)
);
create index room_players_user_id_idx on public.room_players (user_id);
create unique index room_players_active_seat_key on public.room_players (room_id, seat) where left_at is null;

-- The full engine state, including every hand and the RNG state. Never readable by clients (I2).
create table public.room_secrets (
  room_id      uuid primary key references public.rooms (id) on delete cascade,
  engine_state jsonb not null
);

-- Each player's own hand, pushed to that player only (RLS + Realtime).
create table public.room_hands (
  room_id    uuid not null,
  user_id    uuid not null references auth.users (id) on delete cascade,
  hand       jsonb not null,
  version    int not null,
  updated_at timestamptz not null default now(),
  primary key (room_id, user_id),
  foreign key (room_id, user_id) references public.room_players (room_id, user_id) on delete cascade
);
create index room_hands_user_id_idx on public.room_hands (user_id);

-- Public event log. Payloads are always the public redaction (Mind.redactEvent(type, data, null)).
create table public.room_events (
  id         bigserial primary key,
  room_id    uuid not null references public.rooms (id) on delete cascade,
  seq        int not null,
  type       text not null,
  payload    jsonb not null,
  created_at timestamptz not null default now(),
  unique (room_id, seq)
);

-- Sliding-window rate limits for the rooms function (room creations, join attempts).
create table private.rate_limit_hits (
  id         bigserial primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  action     text not null,
  created_at timestamptz not null default now()
);
create index rate_limit_hits_lookup_idx on private.rate_limit_hits (user_id, action, created_at);

create function private.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger rooms_set_updated_at before update on public.rooms
  for each row execute function private.set_updated_at();
create trigger room_hands_set_updated_at before update on public.room_hands
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------------------------------------
-- Privileges and row-level security
-- ---------------------------------------------------------------------------------------------------------

-- Explicit grants, independent of the project's auto-expose default: clients may only SELECT, and never
-- from room_secrets or the private schema's tables. No INSERT/UPDATE/DELETE for anon or authenticated (I3).
revoke all on table public.rooms, public.room_players, public.room_secrets, public.room_hands, public.room_events
  from public, anon, authenticated;
revoke all on sequence public.room_events_id_seq from public, anon, authenticated;
revoke all on table private.rate_limit_hits from public, anon, authenticated;
revoke all on sequence private.rate_limit_hits_id_seq from public, anon, authenticated;
grant select on table public.rooms, public.room_players, public.room_hands, public.room_events to authenticated;

alter table public.rooms enable row level security;
alter table public.room_players enable row level security;
alter table public.room_secrets enable row level security;
alter table public.room_hands enable row level security;
alter table public.room_events enable row level security;
alter table private.rate_limit_hits enable row level security;

-- SECURITY DEFINER so the membership lookup is not itself filtered by room_players' policy (no recursion).
-- Kept in the unexposed `private` schema so it is not callable through the Data API.
create function private.is_room_member(p_room_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_players
    where room_id = p_room_id
      and user_id = (select auth.uid())
      and left_at is null
  );
$$;
revoke all on function private.is_room_member(uuid) from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.is_room_member(uuid) to authenticated;

create policy "Members can read their rooms" on public.rooms
  for select to authenticated using (private.is_room_member(id));
create policy "Members can read the players of their rooms" on public.room_players
  for select to authenticated using (private.is_room_member(room_id));
create policy "Members can read the events of their rooms" on public.room_events
  for select to authenticated using (private.is_room_member(room_id));
create policy "Players can read their own hand" on public.room_hands
  for select to authenticated using (user_id = (select auth.uid()));
-- room_secrets and private.rate_limit_hits: RLS on and no policies at all.

-- ---------------------------------------------------------------------------------------------------------
-- Realtime (Postgres Changes respect the policies above)
-- ---------------------------------------------------------------------------------------------------------

alter publication supabase_realtime add table public.rooms, public.room_players, public.room_events, public.room_hands;

-- ---------------------------------------------------------------------------------------------------------
-- Cleanup, every 10 minutes
-- ---------------------------------------------------------------------------------------------------------

create function private.cleanup_rooms() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  lobby_abandoned   int;
  playing_abandoned int;
  rooms_deleted     int;
  users_deleted     int;
begin
  update public.rooms set status = 'abandoned', version = version + 1
   where status = 'lobby' and last_activity_at < now() - interval '30 minutes';
  get diagnostics lobby_abandoned = row_count;

  update public.rooms set status = 'abandoned', version = version + 1
   where status = 'playing' and last_activity_at < now() - interval '2 hours';
  get diagnostics playing_abandoned = row_count;

  delete from public.rooms where last_activity_at < now() - interval '24 hours';
  get diagnostics rooms_deleted = row_count;

  delete from auth.users u
   where u.is_anonymous
     and u.created_at < now() - interval '30 days'
     and not exists (
       select 1
       from public.room_players p
       join public.rooms r on r.id = p.room_id
       where p.user_id = u.id and p.left_at is null and r.status in ('lobby', 'playing')
     );
  get diagnostics users_deleted = row_count;

  delete from private.rate_limit_hits where created_at < now() - interval '1 day';

  return jsonb_build_object(
    'lobbyAbandoned', lobby_abandoned,
    'playingAbandoned', playing_abandoned,
    'roomsDeleted', rooms_deleted,
    'usersDeleted', users_deleted
  );
end;
$$;
revoke all on function private.cleanup_rooms() from public, anon, authenticated;
revoke all on function private.set_updated_at() from public, anon, authenticated;

create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('the-mind-cleanup-rooms', '*/10 * * * *', 'select private.cleanup_rooms()');
