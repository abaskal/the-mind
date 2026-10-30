# MIND-05 · Online lobby UI: create/join/share room, presence, start

**Epic:** MIND-00 · **Depends on:** MIND-04 (merged) · **PRD:** `docs/online/PRD-the-mind-online.md` · **Hard rules:** I3, I5, I7, I8

## User story
As a player, I want to tap **Play online**, pick a nickname, and either create a room and share its link or join a friend's room from that link. I want to see who's here and start together when everyone is ready.

## Context
- **App structure:**
  - `index.html` has screens `screen-home`, `screen-setup`, `screen-teach`, `screen-faq`, `screen-journal`, and `screen-game`, with hash routing (e.g. `#setup`).
  - Text comes from `MindData.STR`/`I18N` in **TR and EN** through `t(key)`.
  - Settings are saved in `Store` (`localStorage` key `theMind.bgc.v1`).
  - Avatars and modes come from `MODES = [['classic','🧠'],['reverse','🔁'],['blind','🙈'],['dual','🔥']]`.
- **The UI uses `innerHTML` templates.** Every nickname must go through `esc()` or `textContent` (I7).
- **Backend:**
  - Edge Function `rooms`: `create`, `join`, `leave`, `setVariant`.
  - Edge Function `room-action`: `start`.
  - Realtime Postgres Changes on `rooms` and `room_players` (RLS: members only).
  - Realtime Presence.
  - Error codes are listed in `docs/online/BACKEND.md`.
- Offline mode must keep working from `file://` with **no network requests** (I5).

## Scope
1. **Config:**
   - Add `online-config.js` (classic script, committed) that sets `window.MIND_ONLINE = { supabaseUrl: '', supabaseKey: '' }`. MIND-07 fills the values at deploy time from repository variables.
   - For local development, `localStorage['theMind.online.dev'] = '{"supabaseUrl":"…","supabaseKey":"…"}'` overrides the committed values. Document this in `docs/online/BACKEND.md`.
   - Only the publishable/anon key is ever used (I8).
2. **Lazy loading:** load `@supabase/supabase-js` v2 only when the player enters online mode. Use a **pinned exact version** from jsDelivr's UMD build with a Subresource Integrity (`integrity`) hash and `crossorigin="anonymous"`. The offline paths must make zero requests to Supabase or the CDN.
3. **Identity:**
   - On the first online visit, call `supabase.auth.signInAnonymously()` if there is no session. supabase-js stores the session, so reloading keeps the same user and seat.
   - Store the nickname in `Store` and pre-fill it next time.
4. **Home:** add a **Play online 🌐** entry. If config is missing, it is disabled and shows the i18n message "Online play isn't set up yet".
5. **Online screen** (`#online`) with two tabs:
   - **Create:** nickname plus one of the 4 modes, shown with the same mode cards and texts as offline setup.
   - **Join:** nickname plus a 6-character code. The code input turns to uppercase and accepts `abc-123` or `ABC 123`.
6. **Share link:**
   - The link is `<current origin + path>?room=CODE`.
   - Opening it goes straight to Join with the code filled in. If a nickname is saved, the **Join** button is the main action, so it takes one tap.
   - Remove `?room=` from the address bar after reading it (`history.replaceState`).
7. **Lobby screen** (`#lobby`):
   - Show the room code large, with **Copy code**, **Copy link**, and **Share** (`navigator.share` when available).
   - Show the mode, with a picker for the host only (`setVariant`).
   - Show up to 4 seats. Each seat has the nickname, a 👑 for the host, a "you" tag, and a presence dot (online/away from Realtime Presence on channel `room:<roomId>`).
   - Use a **private** Realtime channel (`config: { private: true }`) with a Realtime Authorization policy on `realtime.messages`, added as a new migration, that lets only room members join and track Presence on `room:<roomId>`.
   - The **Start** button is for the host only. It is enabled only when 2–4 players are seated and all are online. Other players see "Waiting for the host…".
   - Add a **Leave** button.
   - Changes from other players appear without reloading the page (Realtime).
   - When the room status becomes `playing`, hand off to the online table (MIND-06). Until then, show a "Game starting…" placeholder.
8. **Rejoin:**
   - If the saved `online.activeRoomId` is still `lobby` or `playing` for this user, the home screen shows a **Rejoin your room** banner.
   - The `ALREADY_IN_GAME` error offers the same rejoin action.
9. **Errors:**
   - Each backend error code maps to a friendly TR/EN message, such as "Room is full", "Name already taken in this room", or "Too many tries — wait a minute".
   - Network failure shows "Can't reach the server" with a retry option.
10. **Code layout:**
    - New classic scripts `online/online-client.js` (auth, API calls, Realtime helpers) and `online/online-lobby.js` (UI).
    - Pure helpers go in a UMD file that Node can test: code normalization, `?room=` parsing, error→i18n key mapping, merging presence with seats, and the share URL builder.

## Out of scope
- The in-game online table (MIND-06), deploy (MIND-07), accounts, and bots in online rooms.

## Acceptance criteria
1. **Offline unchanged:** from `file://` a full offline game still works. A browser network log for Home → offline game shows **no** requests to `supabase.co` or `cdn.jsdelivr.net`.
2. With empty config, **Play online** is disabled and shows the "not set up" message in both TR and EN.
3. **Two-player lobby,** tested with the local Supabase stack and two separate browser contexts (two anonymous users):
   - A creates a room and sees the lobby with a valid code within 2 seconds.
   - B opens A's share link, joins with one tap, and both lobbies show 2 players within 1 second without a reload.
   - A changes the mode, and B sees it.
   - B leaves, and A sees 1 player.
   - When A leaves, B becomes host.
4. **Start rules:** Start is disabled with 1 player or while a player is away. It works with 2–4 players. A 5th player sees "Room is full".
5. **XSS:** a nickname `<img src=x onerror=alert(1)>` appears as plain text everywhere. No `<img>` element is created, and no alert fires. A signed-in user who is not a member can't join the room's Presence channel; the migration includes a pgTAP test for this.
6. **i18n:** a Node test checks that every new `online.*` key exists in both TR and EN.
7. **Layout:** the lobby works at 360×640 (mobile portrait) and at desktop size. Every control can be reached with the keyboard, and player join/leave is announced through the existing `#srLive` region.
8. **Unit tests:** the Node unit tests for the pure helpers pass, and `npm test` and CI are green. *Should:* a Playwright e2e test of criterion 3 runs in CI against the local stack.

## Definition of Done
All acceptance criteria are met, screenshots of the lobby (desktop and mobile, TR and EN) are in the PR, and the PR links this issue.
