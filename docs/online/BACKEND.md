# The Mind Online — Backend

Supabase backend for online play: Postgres with row-level security, anonymous Auth, Realtime and Edge Functions.
It covers the **lobby** (`rooms`, MIND-03), **gameplay** (`room-action`, MIND-04), and the front-end that uses them: the **lobby UI** (MIND-05, see [Front-end](#front-end-mind-05)) and the **online table** (MIND-06, see [Online table](#online-table-mind-06)).

The hard rules in [PRD-the-mind-online.md](./PRD-the-mind-online.md) §7.3 apply. The ones that shape this backend:

- **I1:** the server is the only referee. Order, mistakes, lives, stars, levels and votes are decided by the engine running in `room-action`.
- **I2:** nobody reads another player's hidden cards.
- **I3:** clients never write to tables directly; every write goes through an Edge Function.
- **I4:** there is one rules engine, `engine/mind-engine.js`. The functions use a byte-identical copy (see below), and no rule lives in SQL.
- **I6:** every state change is atomic and committed with a version compare-and-swap, timed by the Postgres clock.
- **I7:** nicknames are never inserted as HTML.
- **I8:** no secrets in the repository.

| Path | What it is |
|---|---|
| `supabase/config.toml` | Local stack config. Anonymous sign-ins are on; `verify_jwt = true` for `rooms` and `room-action` |
| `supabase/migrations/20261102100000_rooms.sql` | Tables, RLS, Realtime publication, cleanup job |
| `supabase/migrations/20261102200000_room_action.sql` | `load_room_for_action` and `commit_room_action`, service role only |
| `supabase/migrations/20261102300000_room_channel.sql` | Realtime Authorization: only room members may join the private channel `room:<roomId>` and track Presence on it |
| `supabase/migrations/20261103100000_room_version_broadcast.sql` | Every room version change is broadcast as `{ "v": version }` on `room:<roomId>` (MIND-06, see [Version broadcast](#version-broadcast-mind-06)) |
| `supabase/functions/rooms/index.ts` | Deno entry point of the `rooms` function. It only wires auth and Postgres |
| `supabase/functions/room-action/index.ts` | Deno entry point of the `room-action` function. It only wires the engine, auth and the RPC repository |
| `supabase/functions/_shared/rooms-rules.mjs` | Lobby business rules, runtime-agnostic, behind a small repository interface |
| `supabase/functions/_shared/rooms-postgres-repo.mjs` | Lobby repository on Postgres (postgres.js), used by `rooms` |
| `supabase/functions/_shared/rooms-memory-repo.mjs` | In-memory lobby repository for the Node tests |
| `supabase/functions/_shared/rooms-http.mjs` | HTTP layer of `rooms`: error mapping |
| `supabase/functions/_shared/room-action.mjs` | Gameplay pipeline, runtime-agnostic: load → engine → commit, retries, rate limit |
| `supabase/functions/_shared/room-action-rpc-repo.mjs` | Gameplay repository: the two SQL functions over PostgREST RPC, as the service role |
| `supabase/functions/_shared/room-action-memory-repo.mjs` | In-memory gameplay repository for the Node tests |
| `supabase/functions/_shared/room-action-http.mjs` | HTTP layer of `room-action`: `Server-Timing`, error mapping |
| `supabase/functions/_shared/http.mjs` | Shared CORS and JSON helpers |
| `supabase/functions/_shared/mind-engine.js` | **Generated** copy of `engine/mind-engine.js` (`npm run sync-engine`) |
| `supabase/tests/database/*.test.sql` | pgTAP tests: RLS, schema, cleanup, gameplay commits, the room channel, the version broadcast |
| `test/rooms.test.mjs`, `test/rooms-postgres.integration.test.mjs` | Node tests: lobby rules (in-memory) and on a real database |
| `test/room-action.test.mjs`, `test/room-action-privacy.test.mjs` | Node tests: gameplay pipeline and the privacy scan |
| `test/room-action.e2e.test.mjs`, `test/engine-sync.test.js` | Two players over HTTP; the engine copy is identical |
| `online-config.js`, `online/*.js` | The lobby UI and its client (MIND-05), see [Front-end](#front-end-mind-05), and the online table (MIND-06), see [Online table](#online-table-mind-06) |
| `test/online-core.test.js`, `test/online-i18n.test.js`, `test/online-wiring.test.js` | Node tests: the lobby's pure helpers, TR/EN texts, and how online play is wired into the page |
| `test/online-lobby.e2e.test.mjs` | The lobby in Chromium (Playwright) against the local stack: `npm run test:e2e:lobby` |
| `test/online-sync.test.js`, `test/online-proxy.test.mjs` | Node tests: the table's clock, event sequencer, seat rotation and state mapping; the engine proxy against the real `room-action` service |
| `test/online-game.e2e.test.mjs` | Three players at the online table in Chromium against the local stack: `npm run test:e2e:game` |
| `.github/workflows/deploy.yml`, `scripts/package-site.mjs` | Deploy on every push to `main`: migrations and functions, then the static site on GitHub Pages (MIND-07, see [DEPLOY.md](./DEPLOY.md)) |
| `.github/workflows/smoke.yml`, `scripts/smoke-online.mjs` | Smoke test: two players play level 1 against a project; the p95 `room-action` round trip must be ≤ 400 ms |
| `test/package-site.test.mjs`, `test/workflows.test.js`, `test/site.e2e.test.mjs` | The packaging, the deploy workflow's contract, and the packaged site under its CSP in Chromium |

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

### Events

The full list of event types and their public payloads is under [`room-action` → Events](#events).

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
- `public.load_room_for_action` and `public.commit_room_action` are `security definer` with an empty `search_path`. `EXECUTE` is revoked from `public`, `anon` and `authenticated`, and **only `service_role`** may run them. The `room-action` function calls them with the service-role key.

## Realtime

`rooms`, `room_players`, `room_events` and `room_hands` are in the `supabase_realtime` publication. Postgres Changes respect the policies above, so a member gets their room's changes and their own hand only. `room_secrets` is never published.

Realtime cannot check `DELETE` events against RLS or filter them, so the lobby does not subscribe to them. Every lobby write also bumps `rooms.version`, so the room's `UPDATE` covers a player leaving.

### Private room channel `room:<roomId>` (MIND-05)

The lobby joins one channel per room, named `room:<roomId>` with the room id in lower case, as a **private** channel (`config: { private: true }`). It carries the room's Postgres Changes and Presence, keyed on the user id. Realtime checks private channels against RLS policies on `realtime.messages` (migration `20261102300000_room_channel.sql`):

| Policy | Allows |
|---|---|
| `SELECT`, extension `presence` or `broadcast` | Joining the channel and receiving its Presence |
| `INSERT`, extension `presence` | Tracking your own Presence |

Both apply only to `authenticated` users who are current members of the room, through `private.is_room_channel_member(realtime.topic())`. That function accepts only `room:<uuid>` topics and then asks `private.is_room_member`, so a player who left is refused at once. Nobody may **send** Broadcast messages on the channel: there is no chat (PRD §5), and game state comes from Postgres.

### Version broadcast (MIND-06)

Postgres Changes are **polled**, and the poller slows down while a table is quiet. In The Mind the table is quiet most of the time, so the other players learned about a play up to about 1.5 s late, against AC1 of MIND-06 (every client within 1 s). Migration `20261103100000_room_version_broadcast.sql` adds a trigger on `rooms`: every `version` change calls `realtime.send({"v": version}, 'version', 'room:<roomId>', private => true)`, which Realtime streams to the channel's members within a few ms. Clients then read what changed through RLS, as before.

- Only the version number is sent: no state and no hand (I2). Only members receive it (the `SELECT` policy above), and clients still cannot send Broadcast messages: the trigger runs inside the server's own writes (I3).
- `realtime.send()` turns any error into a warning, so a Realtime problem can never fail a game commit.
- Postgres Changes still arrive, later, and are dropped as duplicates. They remain the fallback.
- `supabase/tests/database/room_version_broadcast.test.sql` checks one message per version change, the payload, the private flag and the privileges.

This is the one server change in MIND-06. It is additive: no existing table, function or policy changes.

`supabase/tests/database/room_channel.test.sql` checks this through `realtime.authorize()`, the function the Realtime server itself calls: members may join and track Presence, while non-members, members of another room, players who left, `anon` and malformed topics are refused. `realtime.messages` is owned by the Realtime service, which also creates its daily partitions, so that test needs the stack started **with** Realtime.

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
  - Leaving a **`playing`** room sets the room to `abandoned`, marks the seat `left_at`, and appends `gameAborted {by, reason: "left"}`.
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

## Edge Function `room-action`

Gameplay. The server restores the room's engine, applies the action and commits the result. The order in which the server **commits** actions is the official order of play; network delay is accepted (PRD §7.4).

```
POST /functions/v1/room-action
Authorization: Bearer <access token of a seated player>
Content-Type: application/json

{ "roomId": "<uuid>", "type": "<action>", ...input }
```

CORS works like `rooms`. Every response also carries `Server-Timing: load;dur=…, engine;dur=…, commit;dur=…, total;dur=…` in ms. `Access-Control-Expose-Headers` and `Timing-Allow-Origin` are set, so browsers can read it.

### Actions

| `type` | Input | Who / when |
|---|---|---|
| `start` | – | Host only, room in `lobby`, 2–4 seated players. Seats are ordered by `joined_at`. Every player is human, `adapt: false`, the room's variant, and a new 32-bit seed from `crypto.getRandomValues`. The room becomes `playing` |
| `handDown` | – | Put your hand down during a sync |
| `play` | `pileId?` (`"up"`/`"down"`) | Play your most urgent card. The client never picks the value |
| `proposeStar` · `voteStar` | `agree: boolean` (vote) | Throwing star. The proposer counts as yes, and everyone else must vote |
| `refocus` · `pause` · `resume` | – | Any player. Resume can come from someone else than the pauser |
| `nextLevel` | – | Any player, after `levelComplete` |
| `tick` | – | Runs whatever is due. Does nothing (and writes nothing) when nothing is due |
| `rematch` | – | Host only, room `finished`. The room goes back to `lobby`; the seated players stay, and the engine state and hands are deleted. The host can then `setVariant` (`rooms`) and `start` again |
| `endGame` | – | Any player, only after the game has been `paused` for 3 minutes or more. The room becomes `abandoned` and `gameAborted` is appended |

### Response

```jsonc
// 200
{ "ok": true, "version": 12, "serverNow": 1793640000000, "nextDeadlineAt": 1793640001400, "status": "playing",
  "view": { /* engine.viewFor(you): public table + only your own hand */ },
  "events": [{ "seq": 41, "type": "play", "data": { /* redacted for you */ } }] }
// 409
{ "error": { "code": "INVALID_MOVE", "message": "…" }, "view": { … }, "version": 12, "serverNow": …, "nextDeadlineAt": … }
```

- `serverNow` is the Postgres clock in ms. Use it to estimate the clock offset.
- `nextDeadlineAt` is the next moment a `tick` changes something, or `null` while the table waits for a player.
- `view` is `null` in a lobby, for example after `rematch`.
- The `events` are exactly the ones this request committed, numbered like `room_events.seq`.

### Error codes

| Code | HTTP | When |
|---|---|---|
| `INVALID_INPUT` | 400 | Not JSON, bad `roomId`, unknown `type`, non-string `pileId`, `voteStar` without a boolean `agree` |
| `UNAUTHORIZED` | 401 | Missing, invalid or expired token (the gateway also answers 401 itself, see `rooms`) |
| `NOT_A_MEMBER` | 403 | You have no seat in this room, or the room does not exist |
| `NOT_HOST` | 403 | `start` or `rematch` by someone who is not the host |
| `INVALID_MOVE` | 409 | Not possible right now: wrong phase, no card, already voted, a lobby that has not started, a `finished` or `abandoned` room (only `rematch` works there), `endGame` too early. The body carries the current `view` and `version`, so clients resync quietly |
| `CONFLICT_RETRY` | 409 | The room changed under the action 4 times in a row (3 retries). Send it again |
| `RATE_LIMITED` | 429 | More than 15 actions per second from one user. The limit is per function instance, so it is approximate |

### Pipeline

1. **Authenticate:** `auth.getUser(token)`; 401 otherwise.
2. **Load:** `load_room_for_action(room, user)` returns the room, your seat, the seated players, `engine_state`, `version` and `now_ms` from `clock_timestamp()`. The database clock is the only clock (I6). No seat means 403.
3. **Restore:** `MindEngine.fromJSON(engine_state)`, listen with `on('*')`, then `tick(now)`.
4. **Apply** the action at `now`.
5. **No change** (the engine state is identical): answer with the current view and **do not write**. A `tick` with nothing due ends here.
6. **Commit:** `commit_room_action(...)`. On `conflict`, start again from step 2, up to 3 times, then answer `CONFLICT_RETRY`.

If an action is not possible but its `tick` made a due change, that change is committed and the answer is still `INVALID_MOVE`.

`commit_room_action` does everything in **one transaction**:

1. `UPDATE rooms SET version = version + 1, status, public_state, next_deadline_at, last_activity_at = now() WHERE id = $room AND version = $expected`. If no row changes, it returns `{"conflict": true}` and nothing else happens.
2. Upsert `room_secrets.engine_state`.
3. Upsert only the `room_hands` rows that changed. Each row gets the new room version.
4. Insert the events with consecutive `seq`.

### What is stored where (I2)

| Where | What | Who reads it |
|---|---|---|
| `room_secrets.engine_state` | `engine.toJSON()`: every hand, the **seed and RNG state** (they would let a player predict future deals) | Nobody but the server |
| `room_hands` | Each player's own hand, `[{ "v", "pile" }]` | That player (RLS + Realtime) |
| `rooms.public_state` | `engine.viewFor(null)`: the public table, no hand. When the game ends it gains `result: { won, level, maxLevel, stats, variant }` | Members |
| `room_events.payload` | `Mind.redactEvent(type, data, null)`: the public redaction | Members |
| Response | `viewFor(you)` and the events `redactEvent(…, you)` | You |

**Player ids are seat-based (`s0`–`s3`)** in the engine, in `public_state`, in every event and every response. User UUIDs never appear there. `rooms.status` becomes `finished` when the engine reaches `victory` or `gameOver`.

### Events

`room_events` (and the `events` of a response) use the engine's event names and payloads, plus two server events. In **Blind**, a `play` hides `card.v`, `top` and `gap` until that level's `reveal`.

| Type | Public payload |
|---|---|
| `levelStart` | `{ level, maxLevel, reward }` (`reward`: `"star"`, `"life"` or `null`) |
| `syncStart` | `{ reason }`: `level`, `refocus`, `mistake` or `pause` |
| `handDown` | `{ playerId }` |
| `allHandsDown` | `{ reason }`. The sync hold (1.4 s) starts now |
| `playing` | `{ reason }`: the sync reason, or `resume` after a rejected star or a star |
| `play` | `{ playerId, card: { v, pile }, pileId, blind, top, count, gap, elapsed }` |
| `perfectSync` | `{ a, b, delta }`: two plays by different players within 1 s (not in Blind) |
| `mistake` | `{ playerId, card, offenders: [{ playerId, cards }], lives }`. The offenders' lower cards are discarded face up (not in Blind) |
| `starProposed` | `{ proposer, needsHuman }` |
| `starVote` | `{ playerId, agree, timeout? }` |
| `starRejected` | `{ by }` |
| `star` | `{ discards: [{ playerId, v, pile }], stars }` |
| `refocusCalled` | `{ playerId }` (not in Blind) |
| `reveal` | `{ results: [{ pile, index, v, by, ok }], wrong, lives }` (Blind only, at the end of a level) |
| `levelComplete` | `{ level, reward, applied, flawless, lives, stars }` |
| `victory` | `{ level, flawless }` |
| `gameOver` | `{ level }` |
| `paused` · `resumed` | `{ playerId }` |
| `gameAborted` | `{ by, reason }`: `"left"` (from `rooms` → `leave`) or `"endGame"`. The room is `abandoned` |
| `rematch` | `{ by }`. The room is back in `lobby` |

### Concurrency model (I6)

`room-action` uses **optimistic concurrency**:

- Every request works on the version it loaded and commits with a compare-and-swap on `rooms.version`. Nothing is locked while the engine runs.
- When two actions load the same version, the first commit wins. The second one gets `conflict`, reloads and is applied **on top of** the first. That gives the commit order.
  - Two plays both apply, in commit order.
  - A play that lost the race to a mistake finds the table `resolving` and gets `INVALID_MOVE`. It is not moved to that player's next card.
- `rooms` (lobby) writes also bump `version`. If a player leaves during a game, the game becomes `abandoned`, and later actions get `INVALID_MOVE`.
- `seq` numbers are consecutive per room. The compare-and-swap `UPDATE` holds the room's row lock until the commit ends, so concurrent commits cannot interleave.

### Timer model

Edge Functions keep no state, so timers are **stored deadlines** in the engine state, in server ms:

| Deadline | Length |
|---|---|
| Sync hold, after the last hand goes down | 1.4 s |
| Resolve pause after a mistake | 2.8 s |
| Resolve pause after a star | 2.3 s |
| Blind reveal | 0.9 s + 0.38 s per card + 0.6 s, or 1.4 s with mistakes |
| Star vote; a missing vote counts as **no** | 12 s |

- `engine.nextDeadline()` is written to `rooms.next_deadline_at` and returned as `nextDeadlineAt`.
- When the server clock passes it, clients call `tick`. MIND-06 sends it after a random 0–150 ms delay.
- A `tick` before the deadline changes nothing and writes nothing. If several players tick at the same deadline, exactly one state transition happens: the others get `conflict`, reload, find nothing due and write nothing.
- `pause` freezes the table. `resume` moves every deadline by the paused time. After 3 minutes paused, `endGame` is allowed.
- Nothing runs on the server by itself. If nobody ticks, the table waits, and the cleanup job abandons a game after 2 idle hours.

### Engine sharing (I4)

The functions import `../_shared/mind-engine.js` as a side-effect import and read `globalThis.Mind`.

That file is a **generated, byte-identical copy** of `engine/mind-engine.js`, the only source:

- **After changing the engine, run `npm run sync-engine` and commit both files.**
- `test/engine-sync.test.js` (part of `npm test` and CI) fails if they differ.

The copy exists because the edge runtime and the deploy bundle only reliably contain `supabase/functions/`. Locally, `supabase functions serve` does resolve an import from outside that folder, but whether `supabase functions deploy` bundles such a file can only be checked against a real project (MIND-07). The copy works in every case.

## Cleanup

`pg_cron` job `the-mind-cleanup-rooms` runs `private.cleanup_rooms()` every 10 minutes:

- `lobby` rooms idle (`last_activity_at`) for more than 30 minutes become `abandoned`.
- `playing` rooms idle for more than 2 hours become `abandoned`.
- Rooms of any status idle for more than 24 hours are deleted. The delete cascades to players, hands, secrets and events.
- Anonymous `auth.users` older than 30 days with no seat in a `lobby`/`playing` room are deleted.
- Rate-limit hits older than a day are deleted.

The function returns counts, for example `{"lobbyAbandoned":1,"playingAbandoned":0,"roomsDeleted":2,"usersDeleted":0}`. Abandoning a room bumps its `version` but does not count as activity.

## Front-end (MIND-05)

The lobby UI sits next to the offline game in `index.html`. Its code is in four classic scripts, loaded after the app:

| File | What it is |
|---|---|
| `online-config.js` | `window.MIND_ONLINE = { supabaseUrl: '', supabaseKey: '' }`. Committed empty; MIND-07 fills it at deploy time from repository variables |
| `online/online-core.js` | Pure helpers (UMD, tested in Node): room codes, the `?room=` link, config and key checks, error → i18n keys, seats + Presence |
| `online/online-client.js` | Loads supabase-js, signs in anonymously, calls the Edge Functions, reads the room, joins the room channel |
| `online/online-lobby.js` | The Home entry and rejoin banner, and the `#online` (create / join) and `#lobby` screens |

### Config

- Only the project URL and the **publishable (anon) key** may ever be used (I8). `online-core.js` refuses any other key (`sb_secret_…`, or a JWT whose role is not `anon`), and the page then treats online play as not set up.
- With empty values, **Play online** on Home is disabled and says "Online play isn't set up yet" (TR: "Çevrimiçi oyun henüz kurulmadı").
- **Local development:** point the page at your local stack without touching the committed file. In the browser console:

  ```js
  localStorage['theMind.online.dev'] = JSON.stringify({ supabaseUrl: 'http://127.0.0.1:54321', supabaseKey: '<ANON_KEY or PUBLISHABLE_KEY from npx supabase status>' })
  ```

  A valid override wins over `online-config.js`; remove the key to go back. Serve the folder over HTTP (for example `python3 -m http.server 8080`) so share links work. `file://` works too, but its links only open on your own machine.

### Loading and network (I5)

- The online scripts are local files and make **no request** on their own. Offline play, from `file://` or a web server, never contacts Supabase or the CDN.
- `@supabase/supabase-js` loads only when the player enters online mode (`#online` or `#lobby`). It comes from jsDelivr's UMD build at a **pinned exact version**, with Subresource Integrity (`integrity` and `crossorigin="anonymous"`). See `SUPABASE_JS` in `online-client.js`.
- One exception, by design: when an earlier online visit left a room behind (`online.activeRoomId`), Home checks that room to show the **Rejoin your room** banner. Leaving the room, or the room closing, clears it.
- **Upgrading supabase-js:** change `version` and `src`, then set `integrity` to the new file's hash: `curl -s <src> | openssl dgst -sha384 -binary | openssl base64 -A`. `test/online-wiring.test.js` checks that the URL is pinned and integrity-checked.

### Identity and saved state

- On the first online visit the page calls `supabase.auth.signInAnonymously()`. supabase-js keeps the session in `localStorage`, so a reload keeps the same user and seat.
- The nickname and the active room are saved in `Store` (`theMind.bgc.v1` → `online: { nickname, activeRoomId }`). The nickname is pre-filled next time.

### Lobby data flow

- **Writes** only go through the Edge Functions (I3): `rooms` (`create`, `join`, `leave`, `setVariant`) and `room-action` (`start`).
- **Reads** go through PostgREST under RLS: the room (`rooms`) and its seated players (`room_players`).
- **Live updates** come over the private channel `room:<roomId>`. A change to the room or its seats, or a Presence connection arriving or leaving, makes the lobby read the room again. Reads are coalesced, and late answers are dropped.
- **Presence:** each lobby tracks its user on the channel. A seat is *online* while its user has a live connection and *away* otherwise. The host's **Start** works only with 2–4 seated players who are all online.
- **Share link:** `<origin + path>?room=CODE`. Opening it shows Join with the code filled in and removes `?room=` from the address bar. With a saved nickname, Join has the focus, so joining takes one tap.
- **Errors:** every backend error code has a TR/EN message (`online.err.*`, mapped by `errorKey`). A network failure says "Can't reach the server" and offers **Try again**. `ALREADY_IN_GAME` offers **Rejoin your room**.
- **Game start:** when the room becomes `playing`, the lobby shows "Game starting…" and calls `window.MindOnlineTable.enter({ roomId, room, players, userId })` once, which hands over to the [online table](#online-table-mind-06). A `finished` room hands over too, so a reload on the end screen gets back to it.
- Nicknames reach the page only through `textContent` or `esc()` (I7). Joins and leaves are announced in `#srLive`.

## Online table (MIND-06)

The online game reuses the offline table: the same `UI` renderer, `App` modals, sounds and animations. Instead of a local `MindEngine`, they read an **online engine proxy** that the server feeds. Three more classic scripts:

| File | What it is |
|---|---|
| `online/online-sync.js` | Pure helpers (UMD, tested in Node): the server clock estimate, the event sequencer, seat rotation, the `public_state` → UI mapping, missing-player tracking |
| `online/online-engine-proxy.js` | The engine proxy (UMD, tested in Node against the real `room-action` service): MindEngine's read interface, `on()` events and action methods |
| `online/online-table.js` | Takes over from the lobby; Presence pause, the shared pause card, "Reconnecting…", the end of the game, rematch / leave, a game that ends early, and the e2e debug hook |

### Sync model

- **State:** the newest `rooms.public_state` by `version`, plus your own `room_hands` row. Sources: `room-action` replies (`view` = `viewFor(you)`, `version`), Realtime (`rooms` UPDATE, your `room_hands` INSERT/UPDATE) and snapshots. An older version is ignored. A message of the same version can still add what another lacked; for example, an `INVALID_MOVE` reply has no `status`.
- **Events** (`room_events` INSERT, or the `events` of a reply) drive the animations and sounds. They are emitted **strictly in `seq` order**. Early ones wait in a buffer, and duplicates (the reply and Realtime both carry yours) are dropped. Messages of one commit arrive within a few ms, so the proxy groups them for 20 ms and applies the state first: the existing handlers then read the state their event led to. If your hand row lags behind the public hand count, it waits up to 400 ms more.
- **Fast path:** the database announces every new version on the channel ([Version broadcast](#version-broadcast-mind-06)). A client that is behind reads the room, its hand and the events after its last `seq` at once (catch-ups are spaced 250 ms apart). If that read fails or is still behind (a busy server), it tries again while the announced version is missing, up to 5 times. Postgres Changes arrive later and are dropped as duplicates.
- **Gaps:** if a missing `seq` is still missing after 1 s, the proxy fetches a **snapshot**: the room with `public_state`, the seated players, your hand, and the last events. It reads the events after the state, so no event plays twice, and continues from the last `seq`. A snapshot is also taken after a reconnect, when the tab comes back to the foreground, when the browser goes back online, and after `CONFLICT_RETRY` or a failed request.
- A state change that no event explains (a gap, a resync) makes the table **redraw from the state** (`UI.refresh()`).
- Other players' hands are placeholders of the right length; only your hand has values (I2). In Blind, a `play` hides the card from everybody, you included; the proxy fills in your own card, which it knows from your hand.
- No rule is copied (I4): the proxy calls the engine's own `urgent` and `rewardFor`, and the server decides everything else (I1).

### Clock and deadlines

- **Clock:** every `room-action` reply carries `serverNow` (the Postgres clock). The proxy estimates `offset = serverNow + rtt/2 − localNow` and keeps the sample with the **smallest round trip** out of the last 20. It takes 3 samples when the table opens (`tick`, which writes nothing when nothing is due); every action's reply is a sample too, and during a long silence it takes one more every 30 s. Every server time the UI reads (vote deadline, sync-hold start, card times) is converted to local time, so the vote countdown and the sync ring follow the server for everybody.
- **Deadline ticks:** when the server clock passes `nextDeadlineAt` (from `rooms.next_deadline_at` or a reply), the client sends `tick` after a random 0–150 ms. If the state has not changed 1 s later, it ticks once more, even if the first tick is still on its way (ticks are idempotent; it may be stuck on a server worker that is being replaced). If nothing has moved after 2.5 s, another round (tick + one retry) may start. The proxy arms its **own timer** for each deadline, because browsers slow animation frames under load and stop them in background tabs. The frame loop only adds a faster check.
- User actions are never sent twice at once, and never retried by themselves: a lost reply could mean the action was applied, and a `play` sent again would play the next card.

### Table and controls

- You sit at the bottom; the others sit **clockwise in seat order** on the existing seat positions. Each player shows their nickname (as text, I7) and a neutral avatar in the **seat's color** (`SEAT_COLORS`).
- The HUD shows the mode and 🌐. Bot-only features are off: rhythm (difficulty), adaptive tempo, the "tells" lean and its coach tip.
- Controls match offline: Space or a tap on your card plays it (Dual: ↑/↓ or the card), the hand button or **H** puts your hand down, **S** proposes a star, **Y/N** vote, Refocus, Pause/Resume, and **Enter** starts the next level for everybody.
- **Feedback:** a card lifts, or a button looks pressed, at once. The card only lands when the server confirms. `INVALID_MOVE` redraws quietly from the state in the reply, with no toast.

### Presence, pause and reconnecting

- Every client watches Presence on `room:<roomId>`. If a seated player has been missing for **5 s** during sync, play or a star vote, a connected client sends `pause`, after a little random delay. A second `pause` just gets `INVALID_MOVE`.
- The **pause card** opens for everybody on the `paused` event. It says "Waiting for <name>…" while someone is away, and **Resume** works once everybody is back. After a pause in play, resuming starts a new hands-down sync. After **3 minutes** paused (by the server clock, from the `paused` event's time), **End game** appears and calls `endGame`.
- If your own connection drops, a **Reconnecting…** overlay shows. The channel rejoins by itself, and the table then resyncs. A reload or the Home banner takes you back to your seat and your hand through the lobby.
- Leaving the table during a game (navigation, the logo, **Leave**) asks first, because it ends the game for everybody (`rooms` → `leave`). The others then see "Game ended — <name> left" and go back to Home.

### End of game

- `victory` / `gameOver` show the offline end screens, built from `public_state.result` (stats, level). The game is saved to the local journal with `online: true` and the nicknames. The journal shows 🌐. **Online games unlock no badges** (v1), and only offline games count toward the "regular" badge.
- The host sees **Rematch**, which sends everybody back to the lobby (`rematch`); everybody sees **Leave**.

### Shared room channel

The lobby and the table share **one** channel per room: supabase-js returns the same channel for the same topic, and bindings cannot be added once it is subscribed. So `subscribeRoom` creates it with every binding either screen needs (`rooms`, `room_players`, `room_events`, your `room_hands`, Presence), and screens add and remove listeners. Presence stays connected through the hand-over, so nobody looks away when a game starts. The channel closes 3 s after its last listener leaves.

### Debug hook (e2e tests only)

When the local-development override (`theMind.online.dev`) is set, `window.__mindOnlineDebug` exposes `{ version, publicState, seq, status, appliedAt }` of the current table; `appliedAt` maps a version to the wall-clock ms at which this client applied it. It never contains a hand.

### Local edge runtime and timing

The local edge runtime (`supabase start`) runs the functions with `per_worker` and gives each worker **1 s of CPU in total** (2 s hard limit). After that the worker is replaced, and the next request pays a cold start (about 0.5 s, more on a busy machine). Warm `room-action` calls take 5–40 ms. So `npm run test:e2e:game` checks AC1 strictly on how far apart the clients are (each page records when it applied a version: at most 1 s; measured p90 about 200 ms), and only uses a generous end-to-end limit to catch hangs. The real project's limits differ; MIND-07's smoke test measures action latency there (PRD key result 3).

## Local development

You need Docker and Node 20+. Run `npm install` once; it installs the Supabase CLI as a dev dependency, so `npx supabase` works.

| Command | What it does |
|---|---|
| `npm run db:start` | Starts the local Supabase stack (`supabase start`), including Realtime and the Edge Functions. The API is on `http://127.0.0.1:54321` and Postgres on port `54322` |
| `npm run db:reset` | Recreates the local database and applies every migration |
| `npm run db:test` | Runs the pgTAP tests in `supabase/tests/` (`supabase test db`) |
| `npm run functions:serve` | Serves the Edge Functions in the foreground, with hot reload and logs, at `http://127.0.0.1:54321/functions/v1/<name>` |
| `npm test` | Node unit tests, including the gameplay pipeline and the privacy scan. They need no database; the integration and e2e tests are skipped |
| `npm run test:integration` | The rooms rules on the local database. It uses `ROOMS_TEST_DB_URL`, which defaults to the local stack |
| `npm run test:e2e` | Two anonymous players play Classic level 1 over HTTP against the running local stack. The URL and anon key come from `supabase status`, or from `SUPABASE_E2E_URL` / `SUPABASE_E2E_ANON_KEY` |
| `npm run test:e2e:lobby` | The online lobby in Chromium against the running local stack: create, share link, join, Presence, start, a full room, errors, the mobile layout, and no request in offline play. Run `npx playwright install chromium` once first. `ONLINE_E2E_SCREENSHOTS=<dir>` also saves lobby screenshots |
| `npm run smoke` | The smoke test against any project: `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (for the local stack, `API_URL` and `PUBLISHABLE_KEY` from `npx supabase status`). Prints p50/p95; fails above `SMOKE_MAX_P95_MS` (400) |
| `npm run package-site` | Builds the deployable `_site/` from the same two variables |
| `npm run test:e2e:site` | Packages the site against the running local stack and checks it in Chromium: online play under the Content-Security-Policy with no violation, and offline play from `file://` with no request |
| `npm run test:e2e:game` | Three players at the online table in Chromium against the running local stack: Classic levels 1–2, a mistake, stars (yes, no, timeout), a reload, a disconnect with pause / rejoin / resume / End game, Reverse to game over and rematch, Dual, Blind, reconnecting, and 360×640. It fast-forwards one pause by 3 minutes through the database (`ROOMS_TEST_DB_URL`, the local stack by default). `ONLINE_E2E_RECORD=<dir>` also saves frames of a 2-player level |
| `npm run sync-engine` | Copies `engine/mind-engine.js` to `supabase/functions/_shared/mind-engine.js`. Run it after every engine change |
| `npm run db:stop` | Stops the stack |

`npx supabase status` prints the local URL and keys. They are well-known development defaults and only work against your machine.

If `/functions/v1/…` answers `503 name resolution failed` (for example after `db:reset`), the edge runtime container is not running. Run `npm run functions:serve`.

Try the function by hand, once `npm run db:start` is running:

```bash
API=http://127.0.0.1:54321
KEY=...   # the Publishable / anon key from `npx supabase status`
TOKEN=$(curl -s -X POST "$API/auth/v1/signup" -H "apikey: $KEY" -H 'Content-Type: application/json' -d '{}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')    # anonymous sign-in
curl -s "$API/functions/v1/rooms" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"action":"create","nickname":"Ayşe"}'
```

CI (`.github/workflows/ci.yml`) has three jobs:

- `test` runs `npm test`.
- `db-tests` runs `supabase start` (with Realtime, but without Storage, Studio and the other services the tests don't need) and waits for Realtime's `realtime.messages` partitions. It then runs `npm run smoke` against the fresh stack, `supabase test db`, `npm run test:integration`, `npm run test:e2e` and, after `npx playwright install --with-deps chromium`, `npm run test:e2e:lobby`, `npm run test:e2e:game` and `npm run test:e2e:site`.
- `actionlint` lints every workflow file with the official `rhysd/actionlint` image.

Deploying to a real project is a separate workflow; see [DEPLOY.md](./DEPLOY.md).

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
- the env-var **name** `SUPABASE_SERVICE_ROLE_KEY` read in `supabase/functions/rooms/index.ts` and `supabase/functions/room-action/index.ts`;
- the **role name** `service_role` in the `grant execute … to service_role` of the MIND-04 migration and in its pgTAP test;
- fake keys (`sb_secret_example`, `sb_secret_abcdef`, `sb_secret_TOPSECRET`, JWTs with role `service_role`) in `test/online-core.test.js` and `test/package-site.test.mjs`, and the search pattern in `test/online-wiring.test.js`, which check that the front-end and the deploy refuse such keys and never contain or print one;
- a comment in the CLI-generated `supabase/config.toml` that lists the API roles.

Anything else is a leak: rotate the key, then remove it from the history.
