'use strict';

// MIND-07 AC1/AC5 · The deploy and smoke workflows keep the contract of the issue. actionlint checks the syntax in CI
// (job `actionlint`); this test checks what the workflows must do, and that secrets only travel through `env:` (I8).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WF = path.join(__dirname, '..', '.github', 'workflows');
const read = (f) => fs.readFileSync(path.join(WF, f), 'utf8');
const DEPLOY = read('deploy.yml');
const SMOKE = read('smoke.yml');

// The text of one top-level job (from "  <name>:" to the next job or the end).
function job(src, name) {
  const m = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][\\w-]*:\\n|$)`).exec(src);
  assert.ok(m, `job ${name}`);
  return m[1];
}

// Every `run:` script, single-line or block.
function runScripts(src) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run: ?(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] && m[2] !== '|' && m[2] !== '>') { out.push(m[2]); continue; }
    const indent = m[1].length;
    const body = [];
    for (i++; i < lines.length && (lines[i].trim() === '' || lines[i].search(/\S/) > indent); i++) body.push(lines[i]);
    i--;
    out.push(body.join('\n'));
  }
  return out;
}

test('deploy.yml: push to main and by hand, one deploy at a time', () => {
  assert.match(DEPLOY, /\non:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n/);
  assert.match(DEPLOY, /\nconcurrency:\n {2}group: deploy\n {2}cancel-in-progress: false\n/);
  assert.match(DEPLOY, /\npermissions:\n {2}contents: read\n/);
});

test('deploy.yml only ever deploys main, even when started by hand from another branch', () => {
  assert.match(job(DEPLOY, 'backend'), /\n {4}if: github\.ref == 'refs\/heads\/main'\n/);
  assert.match(job(DEPLOY, 'site'), /\n {4}needs: backend\n/, 'site is skipped with backend');
  assert.doesNotMatch(job(DEPLOY, 'site'), /\n {4}if:/, 'site has no condition that could run it without backend');
});

test('deploy.yml backend: settings check, engine copy, link, db push, functions deploy', () => {
  const b = job(DEPLOY, 'backend');
  const order = [
    /Check the deploy settings/,
    /npm run sync-engine\n\s+if ! git diff --exit-code -- supabase\/functions\/_shared\/mind-engine\.js/,
    /uses: supabase\/setup-cli@v1/,
    /run: supabase link --project-ref "\$SUPABASE_PROJECT_REF"/,
    /run: supabase db push/,
    /run: supabase functions deploy rooms room-action --project-ref "\$SUPABASE_PROJECT_REF"/,
  ].map((re) => { const m = re.exec(b); assert.ok(m, String(re)); return m.index; });
  assert.deepEqual(order, order.slice().sort((x, y) => x - y), 'in this order');
  assert.match(b, /SUPABASE_ACCESS_TOKEN: \$\{\{ secrets\.SUPABASE_ACCESS_TOKEN \}\}/);
  assert.match(b, /SUPABASE_DB_PASSWORD: \$\{\{ secrets\.SUPABASE_DB_PASSWORD \}\}/);
  assert.match(b, /SUPABASE_PROJECT_REF: \$\{\{ vars\.SUPABASE_PROJECT_REF \}\}/);
  for (const name of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'SUPABASE_PROJECT_REF', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY']) {
    assert.match(b, new RegExp(`\\[ -n "\\$${name}" \\]`), `the settings check covers ${name}`);
  }
  assert.match(b, /::error title=Deploy settings::Missing/);
});

test('deploy.yml site: after the backend, packages _site/ and deploys it to Pages', () => {
  const s = job(DEPLOY, 'site');
  assert.match(s, /\n {4}needs: backend\n/);
  assert.match(s, /\n {4}permissions:\n {6}contents: read\n {6}pages: write\n {6}id-token: write\n/);
  assert.match(s, /\n {4}environment:\n {6}name: github-pages\n/);
  assert.match(s, /SUPABASE_URL: \$\{\{ vars\.SUPABASE_URL \}\}\n\s+SUPABASE_PUBLISHABLE_KEY: \$\{\{ vars\.SUPABASE_PUBLISHABLE_KEY \}\}\n\s+run: node scripts\/package-site\.mjs _site/);
  assert.match(s, /uses: actions\/upload-pages-artifact@v\d+\n\s+with:\n\s+path: _site/);
  assert.match(s, /id: deployment\n\s+uses: actions\/deploy-pages@v\d+/);
  assert.doesNotMatch(s, /secrets\./, 'the site job needs no secret');
});

test('smoke.yml: by hand only, against production, with a p95 limit', () => {
  assert.match(SMOKE, /\non:\n {2}workflow_dispatch:\n/);
  assert.doesNotMatch(SMOKE, /\n {2}push:|\n {2}pull_request:|\n {2}schedule:/);
  assert.match(SMOKE, /default: '400'/);
  assert.match(SMOKE, /SUPABASE_URL: \$\{\{ vars\.SUPABASE_URL \}\}/);
  assert.match(SMOKE, /SMOKE_MAX_P95_MS: \$\{\{ inputs\.max_p95_ms \}\}/);
  assert.match(SMOKE, /run: node scripts\/smoke-online\.mjs/);
  assert.doesNotMatch(SMOKE, /secrets\./, 'the smoke test needs no secret');
});

test('secrets only reach steps through env:, never inside a script or a with: input (I8)', () => {
  for (const f of fs.readdirSync(WF).filter((x) => x.endsWith('.yml'))) {
    const src = read(f);
    for (const script of runScripts(src)) assert.doesNotMatch(script, /\$\{\{\s*secrets\./, `${f}: a run script must not expand a secret`);
    for (const m of src.matchAll(/^(\s*)([\w-]+): .*\$\{\{\s*secrets\.(\w+)/gm)) {
      assert.equal(m[2], m[3], `${f}: secrets.${m[3]} is only bound to the env variable of the same name`);
    }
    assert.doesNotMatch(src, /echo[^\n]*\$(SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD)/, `${f}: a secret is never echoed`);
  }
});

test('CI lints the workflow files with actionlint', () => {
  assert.match(read('ci.yml'), /docker run --rm -v "\$PWD:\/repo" --workdir \/repo rhysd\/actionlint:\d+\.\d+\.\d+/);
});
