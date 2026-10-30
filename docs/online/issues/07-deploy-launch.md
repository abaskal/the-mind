# MIND-07 · Deploy & launch: GitHub Pages + Supabase CI/CD, smoke test, docs

**Epic:** MIND-00 · **Depends on:** MIND-06 (merged) · **PRD:** `docs/online/PRD-the-mind-online.md` · **Hard rules:** I3, I5, I8

## User story
As the project owner, I want every merge to `main` to deploy the backend and the website automatically. I also want a smoke test and a short guide, so that friends can play at a public URL and I know it works.

## Context
- **Front-end:** static files only. That means `index.html`, `engine/`, `online/`, `online-config.js`, and any assets they reference. There is no build step.
- **Backend:** `supabase/` contains the migrations, the Edge Functions `rooms` and `room-action`, and the `pg_cron` cleanup job.
- **Hosting:** GitHub Pages, which is free for **public** repositories. If the repository is private, Cloudflare Pages or Netlify can host the same static files. Document both options and implement GitHub Pages.
- **Human-only setup:** Heracles can't do these steps. The owner does them, following `DEPLOY.md`:
  - create a Supabase project, region `eu-central-1`;
  - turn on anonymous sign-ins;
  - add the GitHub secrets and variables;
  - set the Pages source to "GitHub Actions".

## Scope
1. **`.github/workflows/deploy.yml`:** runs on push to `main` and through `workflow_dispatch`, with `concurrency: deploy`.
   - **Job `backend`:**
     - `supabase/setup-cli@v1` → `supabase link --project-ref ${{ vars.SUPABASE_PROJECT_REF }}`;
     - `supabase db push`;
     - `supabase functions deploy rooms room-action`;
     - it uses the secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`.
   - **Job `site`** (`needs: backend`):
     - Copy only the runtime files into `_site/`. Leave out `supabase/`, `test/`, `docs/`, `node_modules/`, `.github/`, the legacy `game.js`/`app.js`/`index.previous.html`/`game.test.js`, and `package*.json`.
     - Generate `_site/online-config.js` from the repository variables `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. **Fail with a clear message if either is missing.**
     - Deploy with `actions/upload-pages-artifact` + `actions/deploy-pages`, with `permissions: pages: write, id-token: write`.
   - If `npm run sync-engine` exists (MIND-04), run it and fail if `git diff --exit-code` shows a change.
2. **Smoke test** `scripts/smoke-online.mjs` (Node 20, uses `@supabase/supabase-js` as a devDependency).
   - **Input:** `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` from the environment.
   - **Steps:**
     1. Sign in **two** anonymous users.
     2. Create a room, join it, and `start` a Classic game.
     3. Both players put their hands down. Then, after each `tick`, the script reads each player's own `room_hands` and plays the lowest card held by either player, so there are no mistakes. Repeat until level 1 is complete.
     4. Then `leave`.
   - **Measure** the client round-trip time of every `room-action` call. Print p50 and p95, and **exit non-zero if p95 > 400 ms** or if any step fails.
   - Add a `workflow_dispatch` workflow `smoke.yml` that runs it against production.
3. **CSP (should):** add a `<meta http-equiv="Content-Security-Policy">` that limits `connect-src` to `'self'` plus the Supabase `https://` and `wss://` origins, and `script-src` to `'self'`, `'unsafe-inline'` (needed for the existing inline scripts), and `https://cdn.jsdelivr.net`.
   - Offline play from `file://` must still work with it.
   - If a CSP meta tag breaks `file://` use, inject it only into `_site/index.html` during deploy.
4. **Docs:**
   - `docs/online/DEPLOY.md`, a step-by-step guide for the owner:
     - create the Supabase project (region, plan limits);
     - turn on anonymous sign-ins and check the auth rate limits;
     - find the project ref, the publishable key, and a personal access token;
     - add the GitHub **secrets** (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`) and **variables** (`SUPABASE_PROJECT_REF`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`);
     - turn on Pages, run the first deploy, and run the smoke test;
     - how to restore a paused free project;
     - capacity limits: about 50 four-player rooms on the free plan;
     - what to do if the service-role key leaks (rotate it).
   - `docs/online/PLAYTEST.md`: a checklist for 4 real devices (2 phones, 2 desktops; TR and EN):
     - all 4 modes;
     - a star vote and a refocus;
     - a forced disconnect and rejoin;
     - a rematch;
     - 3 questions about whether the timing felt fair.
   - In `README.md`, add a "Play online" section (URL placeholder, local dev, tests) and a link to the docs.
   - In-app FAQ, a new TR and EN entry about online privacy: "We only store a nickname and game data. Rooms are deleted 24 hours after the last activity. There are no accounts and no email."

## Out of scope
- Custom domain, analytics or telemetry, paid plans, and CAPTCHA.

## Acceptance criteria
**Verifiable in the PR (by Heracles):**
1. `deploy.yml` and `smoke.yml` are valid. Run `actionlint` if it's available; otherwise do a YAML parse check and explain it in the PR.
2. A local run of the `site` packaging step creates `_site/` with exactly the runtime files and the generated `online-config.js`. Leaving out a variable makes the step fail with a clear message.
3. `scripts/smoke-online.mjs` passes against the **local** Supabase stack (`npx supabase start` + `functions serve`) and prints p50/p95.
4. Offline play from `file://` still works with the CSP change, and makes zero network requests.
5. No secrets appear in the repository or in workflow logs, because secrets are only passed through `secrets.*`.
6. `npm test` passes and CI is green.

**Verified by the owner after merge (record in the epic):**
7. The deploy workflow passes on `main`, and the site loads at `https://<user>.github.io/<repo>/`.
8. `smoke.yml` against production passes with p95 ≤ 400 ms.
9. The 4-device playtest in `PLAYTEST.md` passes. Any issues are filed as new GitHub issues.

## Definition of Done
Criteria 1–6 are met, `DEPLOY.md`, `PLAYTEST.md`, and the README are written, and the PR links this issue.
