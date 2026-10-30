# PRD: The Mind Online

## 1. Summary

The Mind already runs in the browser, but you can only play it alone against bots. This project lets 2–4 people play one shared game from their own devices. One player creates a room and the others join with a code. We build it on Supabase plus a free static host, so it costs nothing to run at small scale. The current offline game keeps working exactly as it does today.

## 3. Background

- **Today:** one `index.html` (~200 KB). It has a separate rules engine (`<script id="mind-engine">`) with 4 modes (Classic, Reverse, Blind, Dual), a "hands down" sync step, star votes, refocus, pause, TR/EN text, and a local journal and badges. All other players are bots.
- **The gap:** the real game is about feeling the timing of *other people*. Bots can't give you that, and friends who live apart have no way to play together.
- **Why now:** the engine is already free of DOM code and is driven by events with an injected clock (`tick(now)`). It can run on a server with only small changes. Supabase now has anonymous sign-ins, Realtime, and Edge Functions on its free plan, so we can go online without asking for an email and without running our own server.

## 4. Objective

Let friends play The Mind together online, with fair timing and hidden hands, in under a minute from opening the link.

**Key Results (first 8 weeks after launch)**
1. At least 30 online games reach an ending (win or game over). Source: `rooms.status = 'finished'`.
2. At least 80% of started online games end normally rather than being abandoned. We count a game as abandoned if a player drops and doesn't return within 3 minutes.
3. Online actions are fast. In a smoke test from Turkey/EU, 95% of actions (play → confirmed state) finish within 400 ms. We have zero reports of a player seeing another player's hidden card.

## 5. Market Segments

1. **Friends and families who live apart.** They know The Mind, or want a short party game, and play over a video call. Their constraint is that nobody wants to install an app or create an account.
2. **Remote teams that want a quick ice-breaker.** These are groups of 2–4 people who want a 10–15 minute shared activity. They need it to work in a browser on a work laptop, with no sign-up and no personal data.

**Constraints:** 2–4 players per room, as in the physical game. Text must be in Turkish and English. It must work on mobile and desktop browsers. Players talking about card numbers is against the rules, so we will not build chat.

## 6. Value Propositions

**Segment 1: Friends and families who live apart**
- **Who:** friends and families in different cities who want to play together.
- **Why:** they want a shared game that creates "we did it together" moments. Distance gets in the way.
- **What before:** they hold physical cards on a video call and trust each other, which is clunky and easy to cheat. Or they play the solo bot version alone.
- **How:** share a link. Everyone joins a room, the server deals hidden hands and judges every play fairly, and everyone sees the same table live.
- **What after:** a real game of The Mind with real people in under a minute, with no app and no account.
- **Alternatives:** other online board-game sites, which need accounts and are not The Mind, or physical cards on a call. Our version is free, needs no login, is bilingual, and keeps the polished table UI they already like.

> *For friends who live apart, The Mind Online turns a shared link into a real game of The Mind in under a minute. Hands stay hidden and the timing is fair, and nobody needs an account.*

**Segment 2: Remote teams that want a quick ice-breaker**
- **Who:** team leads and facilitators running remote meetings.
- **Why:** they need a quick activity with no setup that builds trust and focus.
- **What before:** quizzes and polls, which are competitive and not cooperative, or games that need everyone to sign up.
- **How:** one person creates a room and pastes the code in the meeting chat. A level takes about 2–5 minutes.
- **What after:** a cooperative "sync" moment that fits in a meeting. No personal data is collected.
- **Alternatives:** quiz tools and generic party games. We are cooperative, silent, short, and collect no personal data.

> *For remote teams, The Mind Online is a 10-minute ice-breaker everyone can join from one code. There is no sign-up and no personal data, and the team wins or loses together.*

## 7. Solution

### 7.1 Key flow

Home → **Play online** → Create room (choose nickname and mode) → share code or link → friends open the link, enter a nickname, and join → lobby shows 2–4 seats and who is online → host presses **Start** → the normal game flow (hands down → play → star vote / refocus / pause → level complete) runs, now synced for everyone → ending screen → **Rematch** or leave.

### 7.2 Key features (first version)

1. **Rooms:** create, join by 6-character code or link, a lobby with live presence, and host start. There are 2–4 human players and no bots.
2. **Fair server referee:** the server decides the card order, mistakes, lives, stars, and levels. Clients only send what the player wants to do.
3. **Hidden information:** each player only ever receives their own hand. In Blind mode, the values of played cards stay hidden until the reveal.
4. **All 4 modes online:** Classic, Reverse, Blind, and Dual, all using the same rules engine as offline.
5. **Shared table moments:** everyone does hands-down sync, star votes (all players must agree), refocus, and pause together.
6. **Reconnect:** a player can reload or briefly drop and get their seat back. If a player is missing during play, the game pauses for everyone. If they are gone for more than 3 minutes, the game can be ended.
7. **No-account identity:** players use a nickname plus an anonymous Supabase session.
8. **Offline stays intact:** single-player still opens from `file://` with no network. Online code is only loaded when someone enters online mode.
9. **Deploy:** the static site goes on GitHub Pages and the backend on Supabase, through GitHub Actions.

### 7.3 Technology (decided — see issue MIND-04 for details)

**Hard rules (I1–I8)** — every issue must follow them:

| # | Rule |
|---|---|
| I1 | The server is the only referee. Card order, mistakes, lives, stars, levels, and votes are decided on the server. |
| I2 | A client never receives another player's card value that hasn't been revealed. In Blind mode this includes the pile's card values until the reveal. |
| I3 | Clients cannot write to tables directly. Every write goes through a Supabase Edge Function that uses the service-role key, which stays on the server only. |
| I4 | There is one rules engine source file, shared by offline play, the Node tests, and the Edge Function. Rules are never copied into SQL or into a second JS file. |
| I5 | Offline single-player behavior does not change, and it works from `file://` with no network. |
| I6 | Each state change is atomic and uses optimistic concurrency, through a `version` column and a compare-and-swap commit. There is one time source: the Postgres clock. |
| I7 | Text that users type, such as nicknames, is never inserted as HTML. |
| I8 | The front-end holds only the Supabase URL and the publishable (anon) key. No secrets are committed. |

**Architecture:**
- Static front-end on GitHub Pages.
- Supabase Auth with anonymous sign-in.
- Postgres stores rooms, players, a hidden server state, each player's own hand, and an event log, with row-level security (RLS) on every table.
- Edge Functions `rooms` (lobby actions) and `room-action` (gameplay) load the engine, run `tick(now)`, apply the action, and commit atomically.
- Supabase Realtime pushes new events and hand changes to room members. Presence shows who is online.
- Timers, such as sync hold, resolve pauses, and vote timeouts, are stored as deadlines. Clients call `tick` once a deadline passes, and calling it more than once is harmless.

**Why not move the rules into Postgres functions?** It would mean rewriting four modes of rules in SQL, including the Blind-mode longest-run reveal and the Dual piles. That breaks I4 and risks offline and online rules drifting apart.

**Capacity on the free plan:** 200 Realtime connections and 100 messages per second ([Supabase Realtime limits](https://supabase.com/docs/guides/realtime/limits)). That is about 50 four-player rooms at once, which is enough for this first version.

### 7.4 Assumptions and open questions

- **Assumption:** 100–300 ms of network delay is fine for a cooperative timing game, because the server's arrival order decides who played first. We'll check this in a playtest with 4 real players (MIND-07).
- **Assumption:** players bring their own video or voice call if they want eye contact. We will not build video, voice, or chat.
- **Risk:** Supabase pauses free projects after a period of no activity, and a paused project must be restored from the dashboard. *Open:* accept restoring it by hand, or move to the Pro plan if usage grows.
- **Risk:** people could abuse anonymous sign-ins. We counter this with Supabase's built-in auth rate limits, our own limits on actions, room creation, and join attempts, and daily cleanup. We can add a CAPTCHA (Turnstile) later if needed.
- **Open:** do online games unlock badges? *For v1, no.* Online games are recorded in the journal with a 🌐 tag only.
- **Assumption:** the repository will be public so GitHub Pages is free. If it is private, use Cloudflare Pages or Netlify instead (MIND-07).

## 8. Release

**v1 (this epic), 7 issues run one after another by Heracles, about 2–4 weeks of review cycles in total:**
MIND-01 engine extraction → MIND-02 multi-human engine → MIND-03 Supabase rooms backend → MIND-04 gameplay server → MIND-05 online lobby UI → MIND-06 online game UI → MIND-07 deploy and launch checks.

**Later:** bots filling empty seats, spectators, accounts and cross-device history, online badges and leaderboards, more than one room per user, and CAPTCHA.

**Explicitly not doing:** chat, voice, or video; matchmaking with strangers; more than 4 players; changing the offline game's rules or bot behavior.
