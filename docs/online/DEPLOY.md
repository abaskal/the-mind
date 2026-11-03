# Deploying The Mind Online

This guide takes you from nothing to friends playing at a public URL. The deploy itself is automatic: every push to `main` runs [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml). The one-time setup below needs a person, because it involves accounts and secrets.

| What | Where it runs | Cost |
|---|---|---|
| Website (`index.html`, `engine/`, `online/`) | GitHub Pages | Free for a **public** repository |
| Backend (Postgres, Auth, Realtime, Edge Functions `rooms` and `room-action`) | Supabase | Free plan |

The hard rules from the [PRD](./PRD-the-mind-online.md) that matter here:
- **I3:** clients write nothing directly; the Edge Functions do.
- **I5:** offline play keeps working with no network.
- **I8:** the website only ever contains the project URL and the **publishable** key. Every secret below goes into GitHub **secrets** and nowhere else.

## 1. Create the Supabase project

1. Sign in at [supabase.com/dashboard](https://supabase.com/dashboard) and choose **New project**.
2. Fill in the form:
   - **Name:** for example `the-mind`.
   - **Database password:** use **Generate a password** and save it in your password manager. It becomes the `SUPABASE_DB_PASSWORD` secret.
   - **Region:** **Central EU (Frankfurt)**, `eu-central-1`. It is the closest region to Turkey and the EU, where PRD key result 3 (p95 ≤ 400 ms) is measured.
   - **Plan:** Free.
3. Wait until the project is ready (about 2 minutes).

**Free plan limits that matter here** (check [supabase.com/pricing](https://supabase.com/pricing) for the current numbers):
- **Realtime:** 200 concurrent connections and 100 messages per second. Each player holds one connection, so about **50 four-player rooms** can be open at once (PRD §7.3).
- **Pausing:** a project with no activity for about a week is **paused** (see [step 9](#9-a-paused-project)).
- **Database:** 500 MB. Rooms are deleted 24 hours after their last activity, so a game takes little space.

## 2. Turn on anonymous sign-ins

Players sign in anonymously: a nickname, no email, no account.

1. Open **Authentication → Sign In / Providers**.
2. Turn on **Allow anonymous sign-ins** and save.
3. Open **Authentication → Rate Limits** and check **anonymous sign-ins per hour**. The default (30 per IP per hour) is enough for friends; a whole office behind one IP may need a higher value. The backend has its own limits as well: room creations, join attempts, and actions per second.

The local stack has these settings in `supabase/config.toml` (`enable_anonymous_sign_ins = true`). The real project needs them set in the dashboard.

## 3. Collect the values

| Name | Where to find it | Kind |
|---|---|---|
| `SUPABASE_PROJECT_REF` | **Project Settings → General → Project ID**, e.g. `abcdefghijklmnopqrst` | Variable |
| `SUPABASE_URL` | `https://<project ref>.supabase.co` (also under **Project Settings → Data API**) | Variable |
| `SUPABASE_PUBLISHABLE_KEY` | **Project Settings → API Keys → Publishable key**, `sb_publishable_…`. Use this one: the legacy **anon** key is accepted too, but it changes whenever the legacy JWT secret is rolled (see [step 11](#11-if-a-secret-leaks)) | Variable (public by design) |
| `SUPABASE_ACCESS_TOKEN` | Your account (top right) → **Access Tokens → Generate new token**, named for example `the-mind deploy` | **Secret** |
| `SUPABASE_DB_PASSWORD` | The database password from step 1 | **Secret** |

> Never use a **secret** key (`sb_secret_…`) or the **service_role** key for `SUPABASE_PUBLISHABLE_KEY`. The deploy refuses them (`scripts/package-site.mjs`), but they must not even be pasted into a variable: variables are visible to anybody with access to the repository settings, and their values can show up in logs.

## 4. Add the GitHub secrets and variables

In the repository: **Settings → Secrets and variables → Actions**.

- **Secrets** tab → **New repository secret**: `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`.
- **Variables** tab → **New repository variable**: `SUPABASE_PROJECT_REF`, `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`.

Or with the GitHub CLI, from the repository folder. `gh secret set` asks for the value, so it does not end up in your shell history:

```bash
gh secret set SUPABASE_ACCESS_TOKEN
gh secret set SUPABASE_DB_PASSWORD
gh variable set SUPABASE_PROJECT_REF --body "abcdefghijklmnopqrst"
gh variable set SUPABASE_URL --body "https://abcdefghijklmnopqrst.supabase.co"
gh variable set SUPABASE_PUBLISHABLE_KEY --body "sb_publishable_…"
```

## 5. Turn on GitHub Pages

**Settings → Pages → Build and deployment → Source: GitHub Actions.** Nothing else is needed: the workflow uploads the site itself.

The site will be at `https://<user>.github.io/<repository>/`, here `https://abaskal.github.io/the-mind/`.

> **Private repository?** GitHub Pages is only free for public repositories. The same static files can go to **Cloudflare Pages** or **Netlify** instead (see [step 10](#10-hosting-without-github-pages)).

## 6. Recommended: let `rooms` use the connection pooler

The `rooms` function talks to Postgres directly (postgres.js). On the real project, use the **transaction pooler**, which suits short-lived function instances:

1. In the dashboard, press **Connect** (top of the project) and copy the **Transaction pooler** connection string (port `6543`). Put the database password in it.
2. Store it as an Edge Function secret (it contains the password, so never commit it):

   ```bash
   npx supabase secrets set ROOMS_DB_URL="postgresql://postgres.<ref>:<password>@<pooler host>:6543/postgres" --project-ref <ref>
   ```

Without it, `rooms` uses `SUPABASE_DB_URL`, which Supabase provides to every function. `room-action` needs nothing: it uses the PostgREST API.

## 7. The first deploy

Run **Actions → Deploy → Run workflow** on `main` (or merge anything into `main`). Started from any other branch, the workflow skips both jobs: production only ever gets what is on `main`, because a migration cannot be undone. The workflow has two jobs:

1. **`backend`:**
   - checks that all five settings exist, and fails with the names of the missing ones;
   - checks that the functions' engine copy matches `engine/mind-engine.js`;
   - runs `supabase link`, then `supabase db push` (every migration, including the `pg_cron` cleanup job and the Realtime policies);
   - runs `supabase functions deploy rooms room-action`, which keeps `verify_jwt = true` from `supabase/config.toml`.
2. **`site`** (only after `backend` succeeded):
   - `node scripts/package-site.mjs _site` copies only the runtime files;
   - it writes `online-config.js` from `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`;
   - it adds a Content-Security-Policy to `index.html` (scripts from the site and jsDelivr; network only to your project);
   - then the site goes to GitHub Pages.

**Check it:**
- [ ] The workflow is green. The `site` job shows the page URL.
- [ ] The page opens. **Play online 🌐** is enabled; with no or wrong variables it says "Online play isn't set up yet".
- [ ] **Database → Cron** lists `the-mind-cleanup-rooms` (every 10 minutes).
- [ ] **Edge Functions** lists `rooms` and `room-action`.

You can try the packaging locally: `SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=… npm run package-site` writes `_site/`, which is git-ignored.

## 8. The smoke test

Two anonymous players play Classic level 1 against the real project, and every `room-action` round trip is timed. The test fails when a step fails or when the **p95 is above 400 ms**.

- **On GitHub:** **Actions → Smoke test (production) → Run workflow**. GitHub's runners are usually in the US, so this mostly checks that everything works.
- **From Turkey/EU,** which is what PRD key result 3 measures:

  ```bash
  npm ci --ignore-scripts
  SUPABASE_URL=https://<ref>.supabase.co SUPABASE_PUBLISHABLE_KEY=sb_publishable_… npm run smoke
  ```

The output ends with something like `room-action round trips: n=7 · p50 … ms · p95 … ms` and `PASS`. The first call is a warm-up that is reported but not counted, because it can include the function's cold start.

**After the first deploy,** record in the epic (#8):
- the deploy run;
- the site URL;
- the smoke result;
- the [4-device playtest](./PLAYTEST.md).

## 9. A paused project

If nobody plays for about a week, Supabase pauses a free project. The site still loads and offline play still works, but **Play online** answers "Can't reach the server".

1. Open the project in the dashboard and press **Restore project**. It takes a few minutes.
2. Run the smoke test again.

Nothing has to be deployed again. If this happens often, a Pro plan does not pause (PRD §7.4).

## 10. Hosting without GitHub Pages

For a private repository, keep the `backend` job (it deploys Supabase whatever the host) and send the same `_site/` folder elsewhere.

- **Cloudflare Pages:** create a Pages project with the **Direct Upload** method, add the secret `CLOUDFLARE_API_TOKEN` and the variable `CLOUDFLARE_ACCOUNT_ID`, and replace the last two steps of the `site` job with:

  ```yaml
      - run: npx wrangler pages deploy _site --project-name the-mind
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
  ```

- **Netlify:** create a site, add the secret `NETLIFY_AUTH_TOKEN` and the variable `NETLIFY_SITE_ID`, and use:

  ```yaml
      - run: npx netlify-cli deploy --dir _site --prod
        env:
          NETLIFY_AUTH_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}
          NETLIFY_SITE_ID: ${{ vars.NETLIFY_SITE_ID }}
  ```

Both need no build command: `_site/` is already the finished site. Remove the `pages`/`id-token` permissions and the `github-pages` environment from the job.

## 11. If a secret leaks

The site holds no secret: the publishable key is meant to be public, and everything it can do is limited by row-level security and the Edge Functions. If a **secret** leaks (pushed in a commit, pasted in a chat, shown in a log), act at once:

| Leaked | Do this |
|---|---|
| Secret key (`sb_secret_…`) | **Project Settings → API Keys.** Create a new secret key and **delete the leaked one**. The publishable key does not change, and the Edge Functions get their keys from Supabase, so nothing has to be redeployed |
| The legacy `service_role` key | Roll the legacy **JWT secret** (**Project Settings → JWT Keys**). This signs everybody out and **also replaces the legacy anon key**. If `SUPABASE_PUBLISHABLE_KEY` holds the legacy anon key, set it to the new one (better: switch to the `sb_publishable_…` key) and run **Deploy** again. Until then **Play online** fails, because the site still sends the old key. The Edge Functions get their keys from Supabase |
| `SUPABASE_ACCESS_TOKEN` | Account → **Access Tokens**: revoke it, generate a new one, and update the GitHub secret |
| `SUPABASE_DB_PASSWORD` | **Project Settings → Database → Reset database password**. Update the GitHub secret and, if you set it, `ROOMS_DB_URL` (step 6) |

Then remove the secret from the repository history: rewrite it, or ask GitHub support for a cache purge. A rotated key is useless to whoever saw it. Before every PR, the check in [BACKEND.md → Secrets](./BACKEND.md#secrets-i8) shows what may legitimately match.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Deploy settings: Missing …` | A secret or variable from step 4 is missing or misspelled |
| `supabase link` fails | `SUPABASE_PROJECT_REF` is wrong, or `SUPABASE_ACCESS_TOKEN` expired |
| `supabase db push` fails with an authentication error | `SUPABASE_DB_PASSWORD` is not the current database password |
| `Engine copy: … differs` | Someone changed `engine/mind-engine.js` without `npm run sync-engine` |
| `Site packaging: … not a publishable (anon) key` | A secret key was put in `SUPABASE_PUBLISHABLE_KEY` (rotate it, step 11) |
| The site works but **Play online** is greyed out | The site was deployed before the variables existed: run **Deploy** again |
| **Play online** fails for everybody right after a key change | The site still holds an old legacy anon key: update `SUPABASE_PUBLISHABLE_KEY` and run **Deploy** again (step 11) |
| The Deploy jobs show as skipped | It was started from another branch than `main` (step 7) |
| "Couldn't sign you in" | Anonymous sign-ins are off (step 2), or the auth rate limit was reached |
| "Can't reach the server" | The project is paused (step 9) |
