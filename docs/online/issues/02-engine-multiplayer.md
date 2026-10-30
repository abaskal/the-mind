# MIND-02 · Make the engine online-ready (many humans, save/restore, per-player views)

**Epic:** MIND-00 · **Depends on:** MIND-01 (merged) · **PRD:** `docs/online/PRD-the-mind-online.md` · **Hard rules:** I1, I2, I4, I5

## User story
As the online game server, I want to run The Mind for 2–4 human players, save and restore the game between requests, and give each player only what they are allowed to see. This lets the server referee fairly without leaking hidden cards.

## Context
- The engine is in `engine/mind-engine.js`, extracted in MIND-01. Today it assumes **exactly one human** through the `get human()` getter. It is used by `humanPlay`, `placeHand` (default player), `proposeStar` (`needsHuman`), `voteStar` (the human's vote only), the vote timeout in `tick` (`starVote`, human only), and `callRefocus`.
- RNG is a closure (`opts.rng`), so the engine state can't be saved to JSON.
- Engine events (`levelStart`, `syncStart`, `handDown`, `allHandsDown`, `playing`, `play`, `perfectSync`, `mistake`, `starProposed`, `starVote`, `starRejected`, `star`, `refocusCalled`, `reveal`, `levelComplete`, `victory`, `gameOver`, `paused`, `resumed`) drive the UI animations in `index.html`.
- In **Blind** mode, played cards are face down. Their values must stay secret until the `reveal` event.
- An online server is stateless between HTTP requests. It will do: load JSON → restore engine → `tick(now)` → apply action → save JSON.

## Scope
1. **Many humans:** support any mix of humans and bots, including 2–4 humans and 0 bots. Add explicit-player APIs that return `true` or `false` and never throw for invalid moves:
   - `playCard(playerId, pileId?, now)`: plays that player's most urgent card on that pile. If no pile is given, use the first pile where the player has a card. The client never chooses a card value. The existing internal `play(playerObj, pileId, now)` may be kept or renamed.
   - `placeHand(playerId, now)`, `proposeStar(playerId, now)`, `voteStar(playerId, agree, now)`, `callRefocus(playerId, now)`, `pause(playerId, now)`, `resume(playerId, now)`, and `nextLevel(now)`.
   - Keep the existing single-human helpers, such as `humanPlay(pileId, now)`, as thin wrappers so the offline UI keeps working **unchanged**.
2. **Star vote with many humans:** the proposer counts as "yes". Every other human must vote. When the deadline passes (`TIMING.voteTimeout`), every human who hasn't voted counts as "no", and one "no" rejects the star. Bot voting stays as it is today.
3. **Serializable state:**
   - `engine.toJSON()` returns plain JSON with everything needed to continue, including the RNG state, phase, deadlines, vote, piles, discard, stats, tempo, and hands.
   - `MindEngine.fromJSON(json, opts)` restores it. Listeners are not serialized; they are re-attached after restoring.
   - Replace the closure RNG with a serializable seeded RNG, such as a `mulberry32` whose state is stored. When no seed is given, offline play seeds it randomly, so offline still uses random seeds.
4. **Per-player view:** `engine.viewFor(playerId)` returns:
   - public info: phase, level, maxLevel, lives, stars, variant, and each pile's `{id, dir, count, top, cards}`;
   - the discard list, `lastPlay`, the vote (proposer and the votes cast so far), and the deadlines;
   - for each player: `{id, seat, handCount, handDown}`;
   - **only that player's own hand values**.

   In Blind mode, the pile `top` and the `cards[].v` values are `null` until the `reveal` event has been emitted for the level. A view for `null` (a spectator or the server log) contains no hand values at all.
5. **Event visibility:** every emitted event can be redacted with `Mind.redactEvent(type, data, forPlayerId, engine)`. It must:
   - remove other players' hand contents from `levelStart` and other events;
   - remove `card.v` and `top` from `play` events in Blind mode before the reveal.

   Mistake offenders, star discards, and reveal results stay public, because the rules reveal them.
6. **Deadline helper:** `engine.nextDeadline()` returns the earliest timestamp at which `tick(now)` would change state, or `null`. Cases: the sync hold end (`allDownAt + TIMING.syncHold`), `resolveUntil`, the vote deadline, and pending bot votes or plays when bots exist.
7. **Idempotent tick:** calling `tick(now)` when nothing is due changes nothing. A test can check this by comparing `toJSON()` before and after.

## Out of scope
- Network, Supabase, and UI changes, except where needed to keep offline working with the renamed APIs.
- Changing bot timing, difficulty, or adaptive tempo.

## Acceptance criteria
1. All MIND-01 characterization tests still pass with no changes to their expectations. Offline single-player still plays from `file://` with no console errors.
2. **Multi-human tests** (3 humans, 0 bots, seeded):
   - the full Classic level 1–2 flow (hands down → play → level complete → reward);
   - a mistake by player B discards the lower cards of A and C and costs exactly 1 life;
   - a star vote that passes with all yes, fails with one no, and fails on timeout when one player doesn't vote;
   - refocus, then pause and resume by different players.
3. **Save/restore test:** play half a level, then `toJSON` → `JSON.stringify`/`parse` → `fromJSON` and continue. The final state and the full event sequence are the same as for an engine that was never serialized. Test this for each of the 4 variants.
4. **Privacy tests:** for every variant and every event type that happens in a scripted game:
   - `viewFor(A)` and `redactEvent(…, A)` never contain a card value from B's or C's current hand;
   - in Blind mode, no played card value appears before `reveal`.

   Use a recursive scan of the JSON for those numbers, limited to fields named `v`, `hand`, `cards`, and `top`.
5. `nextDeadline()` returns the correct value in the sync, resolving, and starVote phases, and `null` when the game is waiting for a player.
6. Invalid actions return `false` and leave the state unchanged: wrong phase, unknown player, no card, a second vote, voting outside the vote phase, or `nextLevel` before the level is complete.
7. `npm test` passes and CI is green.

## Definition of Done
All acceptance criteria are met, the new APIs are documented in a short JSDoc header at the top of `engine/mind-engine.js`, and the PR links this issue.
