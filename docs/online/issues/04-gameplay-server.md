# MIND-04 · Gameplay server: `room-action` Edge Function with atomic, fair state changes

**Epic:** MIND-00 · **Depends on:** MIND-02 and MIND-03 (merged) · **PRD:** `docs/online/PRD-the-mind-online.md` · **Hard rules:** I1, I2, I3, I4, I6

## User story
As a player in an online room, I want every play, mistake, star vote, and level change judged by one fair referee. I want everyone to see the same result, and I want my cards to stay hidden from the others.

## Context
- The engine (`engine/mind-engine.js`, after MIND-02) has `fromJSON`/`toJSON`, `viewFor(playerId)`, `redactEvent`, `nextDeadline()`, and APIs for each player.
- The tables, RLS, and the `rooms` lobby function come from MIND-03.
- The Mind is a timing game. **The order in which the server commits actions is the official order of play.** Network delay is accepted (PRD §7.4).
- Edge Functions keep no state between requests. Timers therefore become stored deadlines, and clients call `tick` when a deadline passes.

## Scope
1. **Engine sharing (I4):** the function imports `engine/mind-engine.js` as a side-effect import and reads `globalThis.Mind`.
   - If the Supabase deploy bundler can't include files outside `supabase/functions/`, add `npm run sync-engine`. It copies the file to `supabase/functions/_shared/mind-engine.js`.
   - In that case also add a test that **fails if the two files differ**, and run it in CI.
2. **SQL function `commit_room_action(...)`** (migration):
   - It is `security definer`, `EXECUTE` is revoked from `public`, `anon`, and `authenticated`, and only `service_role` is granted it.
   - In **one transaction**:
     1. Run `UPDATE rooms SET version = version + 1, … WHERE id = $room AND version = $expected`. If 0 rows change, return `conflict`.
     2. Upsert `room_secrets.engine_state`.
     3. Upsert only the `room_hands` rows that changed.
     4. Insert the events with consecutive `seq`.
     5. Set `public_state`, `status`, `next_deadline_at`, and `last_activity_at`.
   - Add a helper `load_room_for_action(room_id, user_id)`, also service-role only. It returns the room, the caller's seat, `engine_state`, `version`, and **`now_ms` from `clock_timestamp()`**, which is the single clock (I6).
3. **Edge Function `room-action`** (POST, JWT required, CORS like `rooms`). Body: `{roomId, type, ...}`.
   - **Action types:**
     - `start` (host only; room in `lobby`; 2–4 players): seats are ordered by `joined_at`; create the engine with every player human, `adapt: false`, the room's variant, and a new 32-bit seed from `crypto.getRandomValues`; call `start(now)`; set status to `playing`.
     - `handDown`, `play {pileId?}`, `proposeStar`, `voteStar {agree}`, `refocus`, `pause`, `resume`, `nextLevel`.
     - `tick`: runs due transitions and does nothing if nothing is due.
     - `rematch` (host only; room `finished`): set the status back to `lobby`, keep the seated players, and clear the engine state and hands. The host can then use `setVariant` and `start` again.
     - `endGame` (any player; only after the game has stayed in `paused` for 3 minutes or more): sets status `abandoned` and appends a `gameAborted` event.
   - **Pipeline:**
     1. Authenticate (401 `UNAUTHORIZED`).
     2. `load_room_for_action`; the caller must have a seat, else 403 `NOT_A_MEMBER`.
     3. Restore the engine and run `tick(now)`.
     4. Apply the action, collecting events with `on('*')`.
     5. If nothing changed, return the current view and **do not write**.
     6. Otherwise call `commit_room_action`. On `conflict`, retry from step 2, **up to 3 times**, then return 409 `CONFLICT_RETRY`.
   - **Player IDs inside the engine and in every payload are seat-based (`s0`–`s3`).** User UUIDs never appear in `public_state` or in events.
   - **Response:** `{ok: true, version, serverNow, nextDeadlineAt, view: viewFor(me), events: [redacted for me]}`.
   - An invalid move (wrong phase, no card, already voted, …) returns 409 `{error: {code: 'INVALID_MOVE'}, view, version, serverNow}`, so the client can resync quietly.
   - When the engine phase becomes `victory` or `gameOver`, set the room status to `finished`. Store a summary in `public_state.result`: won, level reached, maxLevel, the stats, and the variant.
   - **Never expose the seed or RNG state.** It stays in `room_secrets`, because it would let a player predict future deals.
   - **Rate limit:** each user gets at most 15 actions per second. An approximate per-instance limiter is acceptable. Beyond that, return 429 `RATE_LIMITED`.
   - Add a `Server-Timing` response header (`load`, `engine`, `commit`, `total`) so latency can be observed.
4. **Event stream contract:** `room_events.payload` holds the public redaction (`redactEvent(type, data, null)`). Private changes reach a player only through their own `room_hands` row (RLS from MIND-03). Document the full list of event types and their public payloads in `docs/online/BACKEND.md`.

## Out of scope
- UI (MIND-05 and MIND-06).
- Bots online.
- Spectators.
- Production deploy (MIND-07).

## Acceptance criteria
1. **Fair ordering (Node, core logic with an in-memory repository and a concurrency simulation):**
   - two `play` actions loaded at the same `version` both end up applied, in commit order, and the second one is retried exactly once;
   - when B commits 60 while A still holds 42, the result is a `mistake` event, 42 is discarded, and the team loses 1 life.
2. **Privacy (I2):** for scripted games in all 4 variants, scan every value written to `public_state` and `room_events.payload`, and every response sent to player X. None of them contains any card value still held in another player's hand, nor the RNG state or seed. In Blind mode, no played value appears before `reveal`.
3. **Multi-player flows** (3 players, seeded):
   - `start` → everyone `handDown` → the sync hold passes through `tick` → `playing`;
   - a full level with a reward;
   - a star vote: everyone yes; one no; a timeout through `tick` after `TIMING.voteTimeout`;
   - refocus; pause and resume by different players;
   - `endGame` is rejected before 3 minutes of pause and accepted after;
   - `rematch` returns the room to `lobby` with the same players, and the next `start` resets level, lives, and stars.
4. **Idempotent tick:** a `tick` with nothing due performs **no** commit (the repository write count stays the same). Four players calling `tick` at the same deadline produce exactly one state transition.
5. **pgTAP:**
   - `authenticated` can't execute `commit_room_action` or `load_room_for_action`;
   - a stale `expected_version` returns `conflict` and changes nothing;
   - the `seq` values stay consecutive with no gaps across commits.
6. **Authorization:** a non-member gets 403. A non-host trying `start` or `rematch` gets 403 `NOT_HOST`. Any action on an `abandoned` or `finished` room (except `rematch`) gets 409 `INVALID_MOVE`.
7. **Should:** an integration test using local Supabase (`supabase start` + `functions serve`). Two anonymous users play Classic level 1 through HTTP, and it runs in the CI `db-tests` job.
8. `npm test` passes and CI is green.

## Definition of Done
All acceptance criteria are met. `docs/online/BACKEND.md` is extended with the `room-action` contract, the event list, the concurrency model, and the timer model. The PR links this issue.
