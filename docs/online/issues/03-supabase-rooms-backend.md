# MIND-03 · Supabase backend: schema, RLS, anonymous auth, room lifecycle

**Epic:** MIND-00 · **Depends on:** MIND-01 (merged) · **PRD:** `docs/online/PRD-the-mind-online.md` · **Hard rules:** I2, I3, I8

## User story
As a player, I want to create a room or join a friend's room with a short code and a nickname, without signing up. As the project owner, I want hidden cards and room data to be safe and old rooms to clean themselves up.

## Context
- **Backend is Supabase:**
  - Postgres with row-level security (RLS);
  - Auth with **anonymous sign-ins**: `supabase.auth.signInAnonymously()` gives a real `auth.uid()` and the `authenticated` role, and the JWT has `is_anonymous = true`;
  - Realtime: Postgres Changes, which respects RLS, plus Presence;
  - Edge Functions (Deno);
  - `pg_cron`.
- Free-plan Realtime limits: 200 concurrent connections and 100 messages per second.
- This issue builds the **lobby** part only. Starting the game and gameplay come in MIND-04.
- Region recommendation, for the human who creates the project: `eu-central-1` (Frankfurt). Most players are in TR/EU.

## Scope
1. **Project scaffold:**
   - Add `supabase` as a devDependency (so `npx supabase` works) and run `npx supabase init`.
   - In `supabase/config.toml`, set `[auth] enable_anonymous_sign_ins = true`.
   - Add the npm scripts `db:start`, `db:reset`, `db:test`, and `functions:serve`.
2. **Migration** (`supabase/migrations/<timestamp>_rooms.sql`):
   - `rooms`:
     - `id uuid pk default gen_random_uuid()`
     - `code text not null`, which must match `^[A-HJ-NP-Z2-9]{6}$`
     - `host_id uuid not null references auth.users on delete cascade`
     - `variant text not null default 'classic'`, one of `classic|reverse|blind|dual`
     - `status text not null default 'lobby'`, one of `lobby|playing|finished|abandoned`
     - `version int not null default 0`
     - `public_state jsonb`
     - `next_deadline_at timestamptz`
     - `created_at`, `updated_at`, `last_activity_at timestamptz not null default now()`
     - A **partial unique index on `code` where `status in ('lobby','playing')`**.
   - `room_players`:
     - `room_id uuid references rooms on delete cascade`
     - `user_id uuid references auth.users on delete cascade`
     - `seat smallint`, from 0 to 3
     - `nickname text not null`
     - `joined_at timestamptz default now()`
     - `left_at timestamptz`
     - `pk (room_id, user_id)`, plus an index on `user_id`.
   - `room_secrets`: `room_id uuid pk references rooms on delete cascade`, `engine_state jsonb not null`. This holds the full engine state, including all hands.
   - `room_hands`: `room_id`, `user_id`, `hand jsonb not null`, `version int not null`, `updated_at`, and `pk (room_id, user_id)`.
   - `room_events`: `id bigserial pk`, `room_id`, `seq int not null`, `type text not null`, `payload jsonb not null`, `created_at`, and `unique (room_id, seq)`. Payloads are always the **public** redaction (`redactEvent(…, null)`).
   - A rate-limit table, or something that does the same job, for the limits below.
3. **RLS:** turn it on for **every** table.
   - `SELECT` policies:
     - `rooms`, `room_players`, `room_events`: allowed only for current members, using a `security definer` helper `is_room_member(room_id)` to avoid recursive policies.
     - `room_hands`: only rows where `user_id = auth.uid()`.
     - `room_secrets`: **no policies at all**.
   - **No `INSERT`/`UPDATE`/`DELETE` policies for `anon` or `authenticated` on any table (I3).**
4. **Realtime:** add `rooms`, `room_players`, `room_events`, and `room_hands` to the `supabase_realtime` publication.
5. **Edge Function `rooms`** (POST, JWT required, JSON in and out, CORS + `OPTIONS`; `Access-Control-Allow-Origin: *` is fine because auth uses a bearer token and no cookies):
   - **Actions:**
     - `create {nickname, variant}` returns `{roomId, code, seat}`.
     - `join {code, nickname}` returns `{roomId, seat}`. The code is case-insensitive, and spaces and dashes are ignored.
     - `leave {roomId}`.
     - `setVariant {roomId, variant}`: host only, lobby only.
   - **Rules:**
     - A room has at most 4 seated players.
     - You can only join a room in `lobby` status, except to **rejoin your own seat**, which works in any active status and returns the same seat.
     - A nickname is 1–16 characters after `trim` + NFC normalization, with no control characters, and must be unique in the room ignoring case.
     - A user is seated in at most one `lobby|playing` room. Creating or joining a new room automatically leaves a lobby room. If the user is in a `playing` room, return `ALREADY_IN_GAME` with that `roomId`.
     - When a player leaves the lobby, they are removed. If the host leaves, the earliest-joined player who is left becomes host. If the last player leaves, the room becomes `abandoned`.
     - When a player leaves a `playing` room, the status becomes `abandoned` and the event `gameAborted {by}` is appended.
   - **Room codes:** 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, generated with `crypto.getRandomValues`, and retried if the code is already in use.
   - **Rate limits per user:** `create` at most 10 per hour; `join` attempts (failed codes included) at most 20 per 10 minutes.
   - **Errors** are returned as `{error: {code, message}}` with an HTTP 4xx status. The codes are: `INVALID_INPUT`, `INVALID_NICKNAME`, `NICKNAME_TAKEN`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `GAME_IN_PROGRESS`, `ALREADY_IN_GAME`, `NOT_HOST`, `RATE_LIMITED`, and `UNAUTHORIZED`.
   - **Code structure:**
     - Business rules go in runtime-agnostic JS under `supabase/functions/_shared/`, behind a small repository interface, so Node tests can run them with an in-memory repository.
     - The Deno entry point only connects auth and Postgres.
     - The service-role key comes only from the function's environment (`SUPABASE_SERVICE_ROLE_KEY`), which Supabase provides automatically.
6. **Cleanup** (`pg_cron` job every 10 minutes):
   - `lobby` rooms idle for more than 30 minutes become `abandoned`;
   - `playing` rooms idle for more than 2 hours become `abandoned`;
   - rooms of any status idle for more than 24 hours are deleted, with cascades;
   - anonymous `auth.users` older than 30 days with no seat in an active room are deleted.
7. **Tests:**
   - pgTAP tests in `supabase/tests/` run with `npx supabase test db`, which needs Docker.
   - Node unit tests cover the `rooms` business rules.
   - In `ci.yml`, add a `db-tests` job using `supabase/setup-cli@v1` → `supabase db start` → `supabase test db`.

## Out of scope
- Starting a game, gameplay, and anything that uses the engine (MIND-04).
- Any UI (MIND-05).
- Production deploy (MIND-07).

## Acceptance criteria
1. `npx supabase db reset` applies the migrations with no errors on a clean local stack.
2. **pgTAP RLS tests** (all must pass):
   - a non-member can't select the room, its players, or its events;
   - a member can;
   - a user can select only their own `room_hands` row;
   - `authenticated` and `anon` get 0 rows from `room_secrets`;
   - `INSERT`, `UPDATE`, and `DELETE` from `authenticated` fail or affect 0 rows on every table.
3. **Business-rule unit tests** (Node, in-memory repository):
   - create a room;
   - join, including codes typed in lowercase or with a dash;
   - a 5th join fails with `ROOM_FULL`;
   - a duplicate nickname gets `NICKNAME_TAKEN`;
   - a bad nickname gets `INVALID_NICKNAME`, for an empty name, 17+ characters, or control characters;
   - joining a room that is `playing` as a new player gets `GAME_IN_PROGRESS`;
   - rejoining as an existing player returns the same seat;
   - the host leaving hands the host role to the next player;
   - the last player leaving makes the room `abandoned`;
   - `ALREADY_IN_GAME` works;
   - both rate limits work;
   - `setVariant` by a non-host gets `NOT_HOST`.
4. Room codes always match `^[A-HJ-NP-Z2-9]{6}$`, as checked by a property test with 1,000 samples.
5. The cleanup job is defined in a migration, and its SQL logic is covered by a pgTAP test that backdates `last_activity_at`.
6. No secret is committed. `git grep -iE "service_role|sb_secret_|eyJhbGci"` finds nothing outside docs that say not to commit them.
7. `npm test` passes, and both CI jobs (`test`, `db-tests`) are green on the PR.

## Definition of Done
All acceptance criteria are met. `docs/online/BACKEND.md` gives the schema overview, RLS summary, function contract (request, response, and error codes), and local dev commands. The PR links this issue.
