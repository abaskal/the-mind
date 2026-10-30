# MIND-06 · Online game UI: synced table, actions, votes, reconnect, rematch

**Epic:** MIND-00 · **Depends on:** MIND-05 (merged) · **PRD:** `docs/online/PRD-the-mind-online.md` · **Hard rules:** I1, I2, I5, I7

## User story
As a player in an online room, I want the same table, sounds, and animations as the offline game, with my friends in the seats around me. Every play, mistake, star vote, refocus, and level should appear for everyone at the same moment. If my connection drops, I want to get back to my seat.

## Context
- The offline UI (`UI`/`App` scripts in `index.html`) reads a local `MindEngine` and listens to its events: `levelStart`, `syncStart`, `handDown`, `allHandsDown`, `playing`, `play`, `perfectSync`, `mistake`, `starProposed`, `starVote`, `starRejected`, `star`, `refocusCalled`, `reveal`, `levelComplete`, `victory`, `gameOver`, `paused`, and `resumed`.
- Seats are drawn around the human using `POS`/`SEAT_XY`, for 1–3 other players.
- **Server (MIND-04):**
  - `room-action` handles `handDown | play | proposeStar | voteStar | refocus | pause | resume | nextLevel | tick | rematch | endGame`.
  - Responses include `version`, `serverNow`, `nextDeadlineAt`, and `view`.
  - `rooms.public_state` (versioned), the player's own `room_hands` row, and `room_events` (`seq`, public payload) stream through Realtime.
  - Player IDs are seat-based (`s0`–`s3`).
- The lobby, identity, config, and supabase-js loading come from MIND-05.

## Scope
1. **Online engine proxy:** `online/online-engine-proxy.js` provides the **same read interface and `on()` events** the offline UI already uses, so the existing render, FX, and sound code can be reused.
   - The read interface covers `phase`, `level`, `maxLevel`, `lives`, `stars`, `variantId`, `blind`, `piles`, `discard`, `players`, `vote`, `lastPlay`, and `stats`.
   - Players show their nickname. Your own hand has real values. Other players' hands are placeholders with the correct length.
   - Action methods call `room-action`.
   - Change the offline UI only where needed, for example for nicknames instead of personas or to hide bot-only UI. **Do not fork the table UI.**
2. **Sync model:**
   - **Source of truth on the client** is the newest `public_state` by `version`, plus the player's own hand row.
   - **Events** drive animations and sounds. Apply them strictly in `seq` order and buffer any that arrive out of order.
   - After a gap that lasts longer than 1 second, a reconnect, or a tab returning to the foreground, fetch a fresh snapshot (public state, own hand, last `seq`) and continue from it.
3. **Clock sync:**
   - Estimate the offset between server and local clock from `serverNow` in responses. Use the sample with the smallest round-trip time: `offset = serverNow + rtt/2 − localNow`.
   - All countdowns (sync-hold ring, vote timer, resolve pauses) use server time.
4. **Deadline ticks:** when the server clock reaches `nextDeadlineAt`, send `tick` after a random 0–150 ms delay. If the state hasn't changed within 1 second, retry once.
5. **Table:**
   - You always sit at the bottom. Other players sit clockwise in seat order, using the existing seat positions.
   - Each player shows their escaped nickname and a neutral avatar whose color is fixed for each seat.
   - The HUD shows the mode plus 🌐.
   - **Hide bot-only features:** difficulty, adaptive tempo, the "tells" lean animation, and coach tips that talk about bots.
6. **Controls,** matching offline:
   - Space or tapping your lowest card plays it. In Dual mode, choose the pile as offline does.
   - The hand button, or `H`, puts your hand down during sync.
   - `S` proposes a star. `Y`/`N` votes.
   - There are Refocus and Pause/Resume buttons. Enter means Next level, and any player can press it.
   - **Feedback:** show local visual feedback within 50 ms, such as the card lifting or the button looking pressed. The card lands only when the server confirms.
   - On `INVALID_MOVE`, resync quietly and show no error toast.
7. **Star vote:** every player sees who proposed it, each player's vote, and a countdown based on the server deadline. Each player can vote once.
8. **Presence and disconnects:**
   - If a seated player is missing from Presence for more than 5 seconds during sync, play, or a star vote, any connected client sends `pause`. The banner then says "Waiting for <name>…".
   - When everyone is back, any player can **Resume**, which goes back to the hands-down sync.
   - After 3 minutes paused, an **End game** button appears and calls `endGame`.
   - If your own connection drops, show a "Reconnecting…" overlay and re-subscribe and resync automatically.
   - Reloading the page puts you back at your seat with your hand.
9. **End of game:**
   - Reuse the offline victory and game-over screens, using `public_state.result`.
   - Save the game to the local journal with `online: true`, the nicknames, and the mode. The journal shows a 🌐 tag. **Online games don't unlock badges in v1.**
   - The host sees **Rematch**, which returns everyone to the lobby. Everyone sees **Leave**.
   - A `gameAborted` event shows "Game ended — <name> left" and goes back to Home.
10. **Debug hook:** when the dev override from MIND-05 is set, expose `window.__mindOnlineDebug` with `{version, publicState, seq}` for e2e tests. It must **never** include other players' hands.
11. **Text:** all new text exists in both TR and EN.

## Out of scope
- Bots in online rooms, spectators, chat, voice, and video.
- Online badges or leaderboards.
- Server changes, except bug fixes found here, which must be noted in the PR.

## Acceptance criteria
1. **Synced play,** tested on the local stack with 3 browser contexts:
   - The players play Classic levels 1–2 to the end.
   - After every action, all three clients reach the same `version`, and their `level`, `lives`, `stars`, pile tops, and hand counts match within 1 second.
2. **Mistake:** every client shows the same discarded cards and loses exactly 1 life, then everyone does a new hands-down sync.
3. **Star:**
   - When all vote yes, every client shows the lowest card per player as discarded.
   - One "no" rejects the star for everyone.
   - A non-voter times out to "no" after 12 seconds.
4. **Modes:**
   - Reverse and Dual show the correct pile directions.
   - In Blind mode, other clients see played cards face down until the reveal, and the reveal animation then runs on all clients.
5. **Disconnect:**
   - Closing B's tab during play pauses the game for A and C within about 6 seconds, with "Waiting for B".
   - When B reopens the site, B returns to the same seat with the same hand. A then resumes, and the hands-down sync starts.
   - After 3 minutes, End game works.
6. **Reload:** reloading during play restores the table within 3 seconds.
7. **Clock:** unit tests show the offset estimator stays within 50 ms with simulated jittery round trips. On the local stack, two clients' vote countdowns differ by less than 250 ms.
8. **Unit tests** (Node) cover:
   - the event sequencer (out-of-order buffering, refetch after a gap, ignoring duplicates);
   - seat rotation so you're always at the bottom;
   - the proxy's mapping from `public_state` to the UI interface.
9. **Regressions:**
   - the nickname XSS check from MIND-05 still passes in-game;
   - offline play from `file://` still makes zero network requests;
   - i18n parity holds;
   - the game is playable at 360×640.
10. `npm test` passes and CI is green. *Should:* a Playwright e2e test of criteria 1–3 runs in CI against the local stack.

## Definition of Done
All acceptance criteria are met, the PR includes a short screen recording or GIF of a 2-player online level, and the PR links this issue.
