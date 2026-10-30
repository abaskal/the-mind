# MIND-01 · Extract the rules engine into one shared file + test/CI foundation

**Epic:** MIND-00 · **Depends on:** nothing · **PRD:** `docs/online/PRD-the-mind-online.md` · **Hard rules:** I4, I5

## User story
As a developer of The Mind, I want the rules engine in its own file with tests, so that the offline game, the tests, and the future online server all use the exact same rules.

## Context
- `index.html` (~4,000 lines) contains 7 inline scripts. The rules engine is `<script id="mind-engine">` (about lines 1035–1659). It defines `class MindEngine` plus `longestRun`, `mulberry32`, `VARIANTS`, `DIFFICULTY`, `TIMING`, `LEVELS_BY_PLAYERS`, `LEVEL_REWARDS`, `MAX_LIVES`, and `MAX_STARS`. It exports them as `module.exports` in Node or as `global.Mind` in the browser.
- The engine has no DOM code. Time is always passed in (`start(now)`, `tick(now)`, …), and randomness comes from `opts.rng`.
- Legacy files `game.js`, `app.js`, `style.css`, `index.previous.html`, and `game.test.js` belong to an older version and are **not** used by `index.html`.
- Players open the game straight from disk (`file://…/index.html`). ES modules do **not** load over `file://`, so the engine must stay a classic script.

## Scope
1. Move the inline engine code **unchanged** into `engine/mind-engine.js`, keeping its UMD-style IIFE. It must work three ways:
   - as a classic `<script src>`, setting `globalThis.Mind`;
   - through Node `require()`, returning the API object;
   - as a side-effect ESM import in Deno (`import './mind-engine.js'` then read `globalThis.Mind`). MIND-04 depends on this.
2. In `index.html`, replace the inline `<script id="mind-engine">…</script>` with `<script id="mind-engine" src="engine/mind-engine.js"></script>` at the same position, so script load order stays the same.
3. Add `package.json` (`"private": true`, `"engines": {"node": ">=20"}`, `"scripts": {"test": "node --test"}`) with no runtime dependencies.
4. Add characterization tests in `test/engine.test.js` using `node:test`, with deterministic `mulberry32(seed)` RNG and explicit `now` values. These lock in today's behavior before MIND-02 refactors it.
5. Add `.github/workflows/ci.yml` to run `npm test` on Node 20 for every push and pull request.
6. Add a `.gitignore` covering `node_modules/`, `.env*`, `supabase/.temp/`, `supabase/.branches/`, and `.DS_Store`.
7. Update `README.md`: say the main app is `index.html` plus `engine/mind-engine.js`, how to run tests, and that `game.js`/`app.js`/`index.previous.html` are legacy.

## Out of scope
- Any change to rules, timing, bots, or the UI. Splitting the other inline scripts (data, ui, app, …). Deleting legacy files.

## Acceptance criteria
1. `engine/mind-engine.js` is the only file that defines `class MindEngine`. `grep -c "class MindEngine" index.html` returns `0`.
2. The engine code is the same as the original inline script apart from indentation and whitespace. The PR description shows the command used to prove this, such as `diff -w`.
3. Opening `index.html` from `file://` in Chrome still works: Home → Setup → start a Classic game with 2 bots → play level 1 to the end. There are no console errors. Verify with a headless browser (Playwright) if one is available; otherwise list the manual check in the PR.
4. A test loads `engine/mind-engine.js` in two ways: with `require()`, and as a classic script in a `vm` context with no `module` and no `window`. Both expose `MindEngine`, `mulberry32`, `longestRun`, and `VARIANTS`.
5. `test/engine.test.js` has **at least 15** passing cases, covering:
   - levels per player count (2→12, 3→10, 4→8; Blind mode is half of that, rounded up);
   - starting lives equal the player count, and stars start at 1;
   - every dealt card is unique, and each hand holds as many cards as the level number;
   - a mistake discards every lower card held by any player and costs 1 life;
   - the star vote: proposing, accepting, rejecting, and timing out, which counts as "no";
   - using a star discards each player's lowest card per pile;
   - level rewards, capped at 5 lives and 3 stars;
   - victory and game over;
   - in Reverse and Dual modes, the pile direction is correct;
   - in Blind mode, the reveal uses `longestRun`, and lives lost are capped at the lives left;
   - pause and resume shift deadlines by the time spent paused;
   - in sync, play only starts after every hand is down and `TIMING.syncHold` has passed.
6. `npm test` passes locally, including the legacy `game.test.js`, and the CI workflow is green on the PR.

## Definition of Done
All acceptance criteria are met, the README is updated, and the PR links this issue.
