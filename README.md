# The Mind

A browser version of the cooperative card game *The Mind*. You play with 1–3 bot teammates.

## Run

Open `index.html` in a browser. You don't need to build or install anything, and it works straight from disk (`file://`) with no network.

The app is `index.html` plus the rules engine in `engine/mind-engine.js`. The engine is a classic script (not an ES module, because those don't load over `file://`). It has no DOM code and is shared by the game, the tests and the online server (`room-action`).

**Changed the engine?** Run `npm run sync-engine` and commit the updated `supabase/functions/_shared/mind-engine.js` too. The Edge Functions load that byte-identical copy, and `npm test` fails if the two files differ.

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
| `docs/online/` | Requirements for online multiplayer, and `BACKEND.md` |

**Legacy (not used by `index.html`):** `game.js`, `app.js`, `style.css`, `index.previous.html` and `game.test.js` belong to an older version of the game. `game.test.js` still runs with `npm test`.
