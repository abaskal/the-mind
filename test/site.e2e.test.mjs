// MIND-07 AC2/AC4 · The packaged site (scripts/package-site.mjs) in Chromium: online play works under its
// Content-Security-Policy with no violation, and the page still plays offline from file:// with no request (I5).
// Skipped unless ONLINE_E2E=1:  npm run db:start && npx playwright install chromium && npm run test:e2e:site
// The API URL and the publishable key come from SUPABASE_E2E_URL / SUPABASE_E2E_ANON_KEY or `supabase status`.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { packageSite } from '../scripts/package-site.mjs';

const enabled = process.env.ONLINE_E2E === '1';

function localStack() {
  if (process.env.SUPABASE_E2E_URL && process.env.SUPABASE_E2E_ANON_KEY) {
    return { api: process.env.SUPABASE_E2E_URL, key: process.env.SUPABASE_E2E_ANON_KEY };
  }
  const out = execFileSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const status = JSON.parse(out.slice(out.indexOf('{')));
  return { api: status.API_URL, key: status.PUBLISHABLE_KEY || status.ANON_KEY };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

describe('the packaged site in the browser', { skip: !enabled && 'set ONLINE_E2E=1 (npm run test:e2e:site) with a local stack running' }, () => {
  let browser, server, base, site, tmp;

  before(async () => {
    const { chromium } = await import('playwright');
    const { api, key } = localStack();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-site-e2e-'));
    site = packageSite({ env: { SUPABASE_URL: api, SUPABASE_PUBLISHABLE_KEY: key }, out: path.join(tmp, '_site') }).out;
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const file = path.normalize(path.join(site, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
      if (!file.startsWith(site + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function player(nickname, issues) {
    const context = await browser.newContext();
    await context.addInitScript((n) => {
      localStorage.setItem('theMind.bgc.v1', JSON.stringify({ lang: 'en', sound: false, online: { nickname: n } }));
      document.addEventListener('securitypolicyviolation', (e) => {
        (window.__cspViolations = window.__cspViolations || []).push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    }, nickname);
    const page = await context.newPage();
    page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) issues.push(`${nickname}: ${m.text()}`); });
    page.on('pageerror', (e) => issues.push(`${nickname}: ${e}`));
    return page;
  }

  it('online play works under the CSP: lobby, share link, start, hands down, a play', async () => {
    const issues = [];
    const A = await player('Ayşe', issues);
    const B = await player('Bora', issues);
    await A.goto(base + '/');
    assert.equal(await A.isEnabled('#onlineBtn'), true, 'the generated online-config.js turns online play on');
    await A.click('#onlineBtn');
    await A.click('#onlineSubmit');
    await A.waitForFunction(() => /^[A-HJ-NP-Z2-9]{6}$/.test(document.querySelector('#lobbyCode')?.textContent || ''), null, { timeout: 10000 });
    const code = await A.textContent('#lobbyCode');
    await B.goto(`${base}/?room=${code}`);
    await B.waitForFunction(async () => !!(await window.MindOnlineClient.currentSession()), null, { timeout: 10000 });
    await B.click('#onlineSubmit');
    await A.waitForFunction(() => !document.querySelector('#lobbyStart').disabled, null, { timeout: 10000 });
    await A.click('#lobbyStart');
    for (const p of [A, B]) await p.waitForSelector('#screen-game.active', { timeout: 10000 });
    await A.keyboard.press('h');
    await B.keyboard.press('h');
    for (const p of [A, B]) await p.waitForFunction(() => window.App.engine && window.App.engine.phase === 'playing', null, { timeout: 8000 });
    const [ha, hb] = await Promise.all([A, B].map((p) => p.$$eval('#hand .card[data-v]', (els) => els.map((e) => Number(e.dataset.v)))));
    const first = Math.min(...ha) < Math.min(...hb) ? A : B;
    await first.keyboard.press('Space');
    for (const p of [A, B]) await p.waitForFunction(() => window.App.engine.piles[0].cards.length === 1, null, { timeout: 5000 });
    for (const p of [A, B]) issues.push(...(await p.evaluate(() => window.__cspViolations || [])));
    assert.deepEqual(issues, []);
    await first.evaluate(() => window.App.teardownGame());
  });

  it('the packaged page still plays offline from file://, with no request (I5)', async () => {
    const issues = [];
    const page = await player('Offline', issues);
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.goto(pathToFileURL(path.join(site, 'index.html')).href);
    await page.click('.cta [data-nav="setup"]');
    await page.click('#startBtn');
    await page.waitForSelector('#screen-game.active');
    await page.waitForTimeout(800);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.App.engine && window.App.engine.phase === 'playing', null, { timeout: 8000 });
    assert.ok((await page.$$('#hand .card[data-v]')).length >= 1);
    assert.deepEqual(requests.filter((u) => !u.startsWith('file:') && !u.startsWith('data:')), []);
    issues.push(...(await page.evaluate(() => window.__cspViolations || [])));
    assert.deepEqual(issues, []);
  });
});
