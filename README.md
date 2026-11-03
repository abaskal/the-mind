# The Mind

A browser version of the cooperative card game *The Mind*. You play with 1–3 bot teammates, or online with 1–3 friends (**Play online 🌐**: a lobby, then the same table, synced by the server).

## Run

Open `index.html` in a browser. You don't need to build or install anything, and it works straight from disk (`file://`) with no network.

Online play needs a Supabase project. Until `online-config.js` holds its URL and publishable key, **Play online** is disabled; offline play never touches the network. For local development against `npm run db:start`, see [BACKEND.md → Front-end](docs/online/BACKEND.md#front-end-mind-05).

The app is `index.html` plus the rules engine in `engine/mind-engine.js`. The engine is a classic script (not an ES module, because those don't load over `file://`). It has no DOM code and is shared by the game, the tests and the online server (`room-action`).

**Changed the engine?** Run `npm run sync-engine` and commit the updated `supabase/functions/_shared/mind-engine.js` too. The Edge Functions load that byte-identical copy, and `npm test` fails if the two files differ.

## Play online

**Play:** `https://abaskal.github.io/the-mind/` (live once the first deploy has run, see below). Choose **Play online 🌐**, pick a nickname, create a room and send the link to 1–3 friends. There are no accounts and no email: a nickname and an anonymous session are enough. Rooms are deleted 24 hours after their last activity.

**How it is built:**
- The site is static and lives on GitHub Pages.
- The server is a Supabase project: Postgres with row-level security, anonymous Auth, Realtime, and the Edge Functions `rooms` (lobby) and `room-action` (the referee).
- Every push to `main` deploys both through `.github/workflows/deploy.yml`.

**Deploying it yourself:** the one-time setup (Supabase project, GitHub secrets and variables, Pages) is in [docs/online/DEPLOY.md](docs/online/DEPLOY.md). Then:
- `npm run smoke` (or the **Smoke test (production)** workflow) checks the live backend;
- [docs/online/PLAYTEST.md](docs/online/PLAYTEST.md) is the checklist for a test with 4 real devices.

**Local development:**
- `npm install` and Docker, then `npm run db:start` for the local Supabase stack.
- Point the page at it with the `theMind.online.dev` override and serve the folder over HTTP, see [BACKEND.md → Front-end](docs/online/BACKEND.md#front-end-mind-05).
- `npm run package-site` builds the deployable `_site/`, see [DEPLOY.md](docs/online/DEPLOY.md#7-the-first-deploy).

**Tests for online play:**

| Command | What it checks |
|---|---|
| `npm test` | Rules, lobby and table logic, packaging and workflow checks; needs no network |
| `npm run test:e2e:lobby` | The lobby in a browser, against the local stack |
| `npm run test:e2e:game` | Three players at the table, against the local stack |
| `npm run test:e2e:site` | The packaged site under its Content-Security-Policy, against the local stack |
| `npm run smoke` | Two players play level 1 against any project and the p95 round trip is measured |

How the online game works: [docs/online/BACKEND.md](docs/online/BACKEND.md). Requirements: [docs/online/PRD-the-mind-online.md](docs/online/PRD-the-mind-online.md).

## Tests

You need Node 20 or newer. `npm test` needs nothing installed.

```bash
npm test        # runs node --test: test/*.test.js, test/*.test.mjs and the legacy game.test.js
```

CI runs the same command on every push and pull request (`.github/workflows/ci.yml`). A second CI job, `db-tests`, tests the online backend on a local Supabase database. To run those tests yourself you need Docker and `npm install`; see [docs/online/BACKEND.md](docs/online/BACKEND.md).

## Rules

- 2 / 3 / 4 players play 12 / 10 / 8 levels. You start with lives equal to the number of players and 1 throwing star.
- In level *n*, every player gets *n* cards from 1–100. There are no turns: play your lowest card when you feel it is next.
- If a card is played while someone still holds a lower card, all those lower cards are discarded and the team loses 1 life.
- Throwing star: every player discards their lowest card.
- You get a star after levels 2, 5 and 8, and a life after levels 3, 6 and 9 (max 5 lives, 3 stars).

**Controls:** `Space` or click your lowest card to play it, `S` to propose a star, `Enter` to start the next level.

## Bots

Each bot waits about `500ms + gap × pace` (±15% jitter) before playing. `gap` is its lowest card minus the top card of the pile. Bots plan their timing again after every play, and they always agree to a proposed star.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The app: page layout, styles, texts (TR/EN), sound, UI and game flow |
| `engine/mind-engine.js` | Rules engine with no DOM code. Sets `window.Mind` in the browser and exports the same API from Node `require()`. Supports 2–4 humans and bots, save/restore (`toJSON`/`fromJSON`), per-player views (`viewFor`) and event redaction (`Mind.redactEvent`) for online play; the API is documented at the top of the file |
| `test/engine.test.js` | Characterization tests for the engine rules: `npm test` |
| `test/engine-online.test.js` | Online-readiness tests: several humans, save/restore in all modes, privacy of hands and Blind cards, deadlines, invalid actions |
| `test/engine-loading.test.js` | Checks that the engine loads with `require()`, as a classic script, and as an ES module |
| `supabase/` | Online backend (Supabase): migrations, RLS, the `rooms` (lobby) and `room-action` (gameplay) Edge Functions and pgTAP tests. See `docs/online/BACKEND.md` |
| `test/rooms.test.mjs` | Lobby rules of the `rooms` function, with an in-memory repository |
| `test/rooms-postgres.integration.test.mjs` | The same rules on a local Supabase database: `npm run test:integration` |
| `test/room-action.test.mjs` | Gameplay pipeline of `room-action`: fair ordering, flows, idempotent ticks, authorization |
| `test/room-action-privacy.test.mjs` | Privacy scan of scripted online games in all 4 modes |
| `test/room-action.e2e.test.mjs` | Two players over HTTP on a local Supabase stack: `npm run test:e2e` |
| `test/engine-sync.test.js` | Fails if the Edge Functions' engine copy differs from `engine/mind-engine.js` |
| `online-config.js` | Supabase URL and publishable key for online play. Empty in git; filled at deploy time |
| `online/` | Online play (classic scripts): `online-core.js` (pure helpers), `online-client.js` (supabase-js, Edge Function calls, the shared room channel), `online-lobby.js` (Home entry, `#online` and `#lobby` screens), `online-sync.js` (clock, event sequencer, seats, state mapping), `online-engine-proxy.js` (an engine-shaped view of the server's game for the table UI) and `online-table.js` (the online table: hand-over, pause, reconnect, end of game) |
| `test/online-core.test.js`, `test/online-i18n.test.js`, `test/online-wiring.test.js` | Lobby helpers, TR/EN texts, and the offline/online wiring of the page |
| `test/online-lobby.e2e.test.mjs` | The lobby in Chromium (Playwright) on a local Supabase stack: `npm run test:e2e:lobby` |
| `test/online-sync.test.js`, `test/online-proxy.test.mjs` | The online table's clock, event sequencer, seat rotation and state mapping, and its engine proxy against the real gameplay service |
| `test/online-game.e2e.test.mjs` | Three players at the online table in Chromium on a local Supabase stack: `npm run test:e2e:game` |
| `scripts/package-site.mjs` | Packages the deployable site into `_site/`: the runtime files, a generated `online-config.js` and the CSP (`npm run package-site`) |
| `scripts/smoke-online.mjs` | Online smoke test: two players play level 1, p95 of the round trips (`npm run smoke`) |
| `.github/workflows/deploy.yml`, `smoke.yml` | Deploy on every push to `main` (Supabase, then GitHub Pages), and the smoke test against production (by hand) |
| `test/package-site.test.mjs`, `test/workflows.test.js`, `test/site.e2e.test.mjs` | The packaging, the deploy workflow's contract, and the packaged site in a browser (`npm run test:e2e:site`) |
| `docs/online/` | Requirements for online multiplayer, `BACKEND.md`, `DEPLOY.md` (deploy guide) and `PLAYTEST.md` (4-device checklist) |

**Legacy (not used by `index.html`):** `game.js`, `app.js`, `style.css`, `index.previous.html` and `game.test.js` belong to an older version of the game. `game.test.js` still runs with `npm test`.
