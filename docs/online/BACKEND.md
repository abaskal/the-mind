# The Mind Online — Backend

Supabase backend for online play: Postgres with row-level security, anonymous Auth, Realtime and Edge Functions.
This page covers the **lobby** (MIND-03). Gameplay (`room-action`) is added in MIND-04.

The hard rules in [PRD-the-mind-online.md](./PRD-the-mind-online.md) §7.3 apply. The ones that shape this backend:

- **I2:** nobody reads another player's hidden cards.
- **I3:** clients never write to tables directly; every write goes through an Edge Function.
- **I6:** every state change is atomic and committed with a version compare-and-swap, timed by the Postgres clock.
- **I8:** no secrets in the repository.

| Path | What it is |
|---|---|
| `supabase/config.toml` | Local stack config. Anonymous sign-ins are on; `[functions.rooms] verify_jwt = true` |
| `supabase/migrations/20261102100000_rooms.sql` | Tables, RLS, Realtime publication, cleanup job |
| `supabase/functions/rooms/index.ts` | Deno entry point of the `rooms` function. It only wires auth and Postgres |
| `supabase/functions/_shared/rooms-rules.mjs` | Lobby business rules, runtime-agnostic, behind a small repository interface |
| `supabase/functions/_shared/rooms-postgres-repo.mjs` | Repository on Postgres (postgres.js), used by the function |
| `supabase/functions/_shared/rooms-memory-repo.mjs` | In-memory repository for the Node tests |
| `supabase/functions/_shared/rooms-http.mjs` | HTTP layer: CORS, JSON, error mapping |
| `supabase/tests/database/*.test.sql` | pgTAP tests: RLS, schema, cleanup |
| `test/rooms.test.mjs`, `test/rooms-postgres.integration.test.mjs` | Node tests: rules (in-memory) and rules on a real database |

## Schema

All times come from the Postgres clock (`now()`).

### `public.rooms`

One game table.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key, `gen_random_uuid()` |
| `code` | `text` | Must match `^[A-HJ-NP-Z2-9]{6}$`. Unique among `lobby`/`playing` rooms (partial unique index), so old codes can be reused |
| `host_id` | `uuid` | References `auth.users`, on delete cascade |
| `variant` | `text` | `classic` (default), `reverse`, `blind` or `dual` |
| `status` | `text` | `lobby` (default), `playing`, `finished` or `abandoned` |
| `version` | `int` | Starts at 0 and goes up by 1 on every change (I6) |
| `public_state` | `jsonb` | Public game state (MIND-04) |
| `next_deadline_at` | `timestamptz` | Next timer deadline (MIND-04) |
| `created_at`, `updated_at`, `last_activity_at` | `timestamptz` | `updated_at` is set by a trigger. `last_activity_at` is set by every function write and drives the cleanup |

### `public.room_players`

Seats. The primary key is `(room_id, user_id)`, and there is an index on `user_id`.

| Column | Type | Notes |
|---|---|---|
| `room_id` | `uuid` | References `rooms`, on delete cascade |
| `user_id` | `uuid` | References `auth.users`, on delete cascade |
| `seat` | `smallint` | 0–3. Unique among players who have not left |
| `nickname` | `text` | 1–16 characters, NFC-normalized (enforced by checks) |
| `joined_at` | `timestamptz` | |
| `left_at` | `timestamptz` | Set when a player leaves a `playing` room. Lobby leavers are deleted instead |

### `public.room_secrets`

The full engine state, with every hand and the RNG state. **No client can read it.**

| Column | Type | Notes |
|---|---|---|
| `room_id` | `uuid` | Primary key, references `rooms`, on delete cascade |
| `engine_state` | `jsonb` | |

### `public.room_hands`

Each player's own hand. The primary key is `(room_id, user_id)`.

| Column | Type | Notes |
|---|---|---|
| `room_id`, `user_id` | `uuid` | References the seat in `room_players`, on delete cascade |
| `hand` | `jsonb` | |
| `version` | `int` | |
| `updated_at` | `timestamptz` | |

### `public.room_events`

Public event log.

| Column | Type | Notes |
|---|---|---|
| `id` | `bigserial` | Primary key |
| `room_id` | `uuid` | References `rooms`, on delete cascade |
| `seq` | `int` | `unique (room_id, seq)`, consecutive per room |
| `type` | `text` | |
| `payload` | `jsonb` | Always the **public** redaction (`redactEvent(…, null)`). Player ids are seat-based (`s0`–`s3`), never user ids |
| `created_at` | `timestamptz` | |

### `private.rate_limit_hits`

Sliding-window rate limits, keyed on `(user_id, action, created_at)`. It lives in the unexposed `private` schema.

### Events so far

| Type | Payload | When |
|---|---|---|
| `gameAborted` | `{ "by": "s2" }` | A player left a `playing` room, so the room became `abandoned`. `by` is that player's seat id |

## Row-level security and privileges

RLS is **on for every table** (`public` and `private`). Clients only ever read.

| Table | `anon` | `authenticated` |
|---|---|---|
| `rooms`, `room_players`, `room_events` | no access | `SELECT` only rows of rooms where the caller is a current member (`private.is_room_member(room_id)`) |
| `room_hands` | no access | `SELECT` only rows with `user_id = auth.uid()` |
| `room_secrets` | no access | no access: no grant, RLS on, **no policies at all** |
| `private.rate_limit_hits` | no access | no access |

- **No `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE` privilege and no write policy for `anon` or `authenticated`, on any table (I3).** The migration revokes everything and then grants only the `SELECT`s above. So it does not depend on the project's auto-expose default.
- `private.is_room_member(room_id)` is `security definer`, so the membership check is not itself filtered by `room_players`' policy, which would make it recursive. A player who has left (`left_at` set) is no longer a member.
- `private.is_room_member`, `private.cleanup_rooms` and `private.set_updated_at` live in the `private` schema, which the Data API does not expose. Only `authenticated` may execute `is_room_member`, because policies need it.

## Realtime

`rooms`, `room_players`, `room_events` and `room_hands` are in the `supabase_realtime` publication. Postgres Changes respect the policies above, so a member gets their room's changes and their own hand only. `room_secrets` is never published.

Free plan limits: 200 concurrent connections and 100 messages per second.

## Edge Function `rooms`

```
POST /functions/v1/rooms
Authorization: Bearer <access token of a signed-in user, e.g. from supabase.auth.signInAnonymously()>
Content-Type: application/json

{ "action": "create" | "join" | "leave" | "setVariant", ...input }
```

- `OPTIONS` returns `204` with CORS headers. `Access-Control-Allow-Origin: *` is safe because auth uses a bearer token and no cookies.
- Success is `200` with the action's JSON result. Rule violations are `4xx` with `{ "error": { "code", "message", ...extra } }`. Unexpected failures are `500` with `{ "error": { "code": "INTERNAL", "message" } }`, with no details.
- The body is at most 4 KB.

### Actions

| Action | Input | Result |
|---|---|---|
| `create` | `{ nickname, variant? }` (`variant` defaults to `classic`) | `{ roomId, code, seat }`. The creator is the host, in seat 0 |
| `join` | `{ code, nickname }` | `{ roomId, seat }` |
| `leave` | `{ roomId }` | `{ roomId }` |
| `setVariant` | `{ roomId, variant }` | `{ roomId, variant }`. Host only, lobby only |

### Rules

- **Room codes:** 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, with no `I`, `O`, `0` or `1`. They are generated with `crypto.getRandomValues` and retried while an active room uses the code. When joining, codes are case-insensitive, and spaces and dashes are ignored: `abc-234` = `ABC234`.
- **Nicknames:** `trim` + NFC, then 1–16 characters. No control characters, line or paragraph separators, or bidi overrides. A nickname must be unique in the room ignoring case, and the Turkish `I ı İ i` count as the same letter. Clients must still render nicknames as text, never as HTML (I7).
- **Seats:** at most 4 seated players. A new player takes the lowest free seat.
- **Joining:**
  - A new player can only join a `lobby` room.
  - A player can **rejoin their own seat** in a `lobby` or `playing` room and gets the same seat back. Their nickname is not checked again.
- **One active room per user:** a user is seated in at most one `lobby`/`playing` room.
  - Creating or joining another room first leaves the current lobby, but only if the new action succeeds.
  - If the user is in a `playing` room, the answer is `ALREADY_IN_GAME` with that `roomId`.
- **Leaving:**
  - A **lobby** player is removed. If the host left, the earliest-joined remaining player becomes host. If nobody is left, the room becomes `abandoned`.
  - Leaving a **`playing`** room sets the room to `abandoned`, marks the seat `left_at`, and appends `gameAborted {by}`.
- **Rate limits per user:**
  - `create`: at most 10 successful creations per hour.
  - `join`: at most 20 attempts per 10 minutes, failed and unknown codes included.

### Error codes

| Code | HTTP | When |
|---|---|---|
| `INVALID_INPUT` | 400 (405 for a non-POST method, 413 for a body over 4 KB) | Not JSON, unknown action, wrong types, unknown variant, malformed `roomId` |
| `INVALID_NICKNAME` | 400 | Empty, more than 16 characters, or forbidden characters |
| `UNAUTHORIZED` | 401 | Missing, invalid or expired token |
| `NOT_HOST` | 403 | `setVariant` by someone who is not the host |
| `ROOM_NOT_FOUND` | 404 | No active room has this code, or you are not in this room (`leave`, `setVariant`) |
| `NICKNAME_TAKEN` | 409 | Someone in the room already uses the nickname (ignoring case) |
| `ROOM_FULL` | 409 | 4 players are already seated |
| `GAME_IN_PROGRESS` | 409 | A new player tries to join a `playing` room, or `setVariant` after the start |
| `ALREADY_IN_GAME` | 409 | You are seated in a `playing` room. `error.roomId` names it |
| `RATE_LIMITED` | 429 | Too many creations or join attempts |

`verify_jwt = true`, so the Supabase gateway rejects a missing or malformed token **before** the function runs. It answers `401` with its own body (`{ "code": "UNAUTHORIZED_…", "message" }`), not `{ "error": … }`. Clients should treat **every 401 as `UNAUTHORIZED`** and sign in again.

### Code structure

- `rooms-rules.mjs` holds every rule. It uses no Deno, Node or database API, so Node tests run it with the in-memory repository, and the function runs it with the Postgres one.
- `index.ts` verifies the caller's token with `supabase.auth.getUser()`, then connects to Postgres with a server role through `SUPABASE_DB_URL`. If `ROOMS_DB_URL` is set, it is used instead, for example for the transaction pooler.
- Supabase provides `SUPABASE_URL`, `SUPABASE_DB_URL` and the service-role key to the function's environment automatically. They are never in the repository.

### Concurrency (I6)

Each action runs in **one transaction**:

1. A per-user advisory lock serializes one user's actions, which keeps "one active room per user" true.
2. The rate-limit window is checked.
3. The rooms involved are locked with `SELECT … FOR UPDATE`, in id order so that two players swapping lobbies cannot deadlock.
4. Every room change is a compare-and-swap commit: `UPDATE rooms … SET version = version + 1 WHERE id = $id AND version = $expected`.

If the CAS finds a different version, the whole transaction rolls back, and the service runs the action again (at most 3 retries) before it fails with `500 INTERNAL`.

A failed join attempt still commits its rate-limit hit, because rule violations are returned as results and not thrown.

## Cleanup

`pg_cron` job `the-mind-cleanup-rooms` runs `private.cleanup_rooms()` every 10 minutes:

- `lobby` rooms idle (`last_activity_at`) for more than 30 minutes become `abandoned`.
- `playing` rooms idle for more than 2 hours become `abandoned`.
- Rooms of any status idle for more than 24 hours are deleted. The delete cascades to players, hands, secrets and events.
- Anonymous `auth.users` older than 30 days with no seat in a `lobby`/`playing` room are deleted.
- Rate-limit hits older than a day are deleted.

The function returns counts, for example `{"lobbyAbandoned":1,"playingAbandoned":0,"roomsDeleted":2,"usersDeleted":0}`. Abandoning a room bumps its `version` but does not count as activity.

## Local development

You need Docker and Node 20+. Run `npm install` once; it installs the Supabase CLI as a dev dependency, so `npx supabase` works.

| Command | What it does |
|---|---|
| `npm run db:start` | Starts the local Supabase stack (`supabase start`), including the Edge Functions. The API is on `http://127.0.0.1:54321` and Postgres on port `54322` |
| `npm run db:reset` | Recreates the local database and applies every migration |
| `npm run db:test` | Runs the pgTAP tests in `supabase/tests/` (`supabase test db`) |
| `npm run functions:serve` | Serves the Edge Functions in the foreground, with hot reload and logs, at `http://127.0.0.1:54321/functions/v1/<name>` |
| `npm test` | Node unit tests. They need no database; the Postgres integration test is skipped |
| `npm run test:integration` | The rooms rules on the local database. It uses `ROOMS_TEST_DB_URL`, which defaults to the local stack |
| `npm run db:stop` | Stops the stack |

`npx supabase status` prints the local URL and keys. They are well-known development defaults and only work against your machine.

Try the function by hand, once `npm run db:start` is running:

```bash
API=http://127.0.0.1:54321
KEY=...   # the Publishable / anon key from `npx supabase status`
TOKEN=$(curl -s -X POST "$API/auth/v1/signup" -H "apikey: $KEY" -H 'Content-Type: application/json' -d '{}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')    # anonymous sign-in
curl -s "$API/functions/v1/rooms" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"action":"create","nickname":"Ayşe"}'
```

CI (`.github/workflows/ci.yml`) has two jobs:

- `test` runs `npm test`.
- `db-tests` runs `supabase db start`, then `supabase test db`, then `npm run test:integration`.

## Secrets (I8)

- **Never commit** the service-role key, `sb_secret_…` keys, the JWT secret, database passwords or `.env` files. `.env*`, `supabase/.temp/` and `supabase/.branches/` are git-ignored.
- The front-end only ever gets the project URL and the publishable (anon) key.
- The service-role key and the database URL exist only in the Edge Function's environment, which Supabase fills in.

Check before every PR:

```bash
git grep -iE "service_role|sb_secret_|eyJhbGci"
```

Expected matches, none of them a secret:

- this page and the issue texts in `docs/online/`;
- the env-var **name** `SUPABASE_SERVICE_ROLE_KEY` read in `supabase/functions/rooms/index.ts`;
- a comment in the CLI-generated `supabase/config.toml` that lists the API roles.

Anything else is a leak: rotate the key, then remove it from the history.
