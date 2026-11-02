// MIND-05 · The online lobby in real browsers (Playwright, Chromium) against a local Supabase stack.
// Covers AC1 (offline makes no request), AC2 (not set up), AC3 (two-player lobby), AC4 (start rules), AC5 (XSS and
// the private Presence channel), AC7 (mobile layout, keyboard, #srLive) and the error messages.
// Skipped unless ONLINE_E2E=1:  npm run db:start && npx playwright install chromium && npm run test:e2e:lobby
// The API URL and the anon key come from SUPABASE_E2E_URL / SUPABASE_E2E_ANON_KEY, or else from `supabase status`.
// ONLINE_E2E_SCREENSHOTS=<dir> also saves lobby screenshots (desktop and mobile, TR and EN).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const enabled = process.env.ONLINE_E2E === '1';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.ONLINE_E2E_SCREENSHOTS || '';
const XSS = '<img src=x onerror=alert(1)>';
const XSS_TYPED = XSS.slice(0, 16); // what the 16-character nickname field keeps
const DESKTOP = { width: 1280, height: 860 };
const MOBILE = { width: 360, height: 640 };

function localStack() {
  if (process.env.SUPABASE_E2E_URL && process.env.SUPABASE_E2E_ANON_KEY) {
    return { api: process.env.SUPABASE_E2E_URL, key: process.env.SUPABASE_E2E_ANON_KEY };
  }
  const out = execFileSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const status = JSON.parse(out.slice(out.indexOf('{')));
  return { api: status.API_URL, key: status.ANON_KEY };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Serves the repository like the static host will (GitHub Pages).
function startStaticServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = path.normalize(path.join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('online lobby in the browser (local Supabase)', { skip: !enabled && 'set ONLINE_E2E=1 (npm run test:e2e:lobby) with a local stack running' }, () => {
  let browser, server, base, stack;
  const contexts = [];

  before(async () => {
    const { chromium } = await import('playwright');
    stack = localStack();
    server = await startStaticServer();
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  });

  after(async () => {
    for (const c of contexts) await c.close().catch(() => {});
    if (browser) await browser.close();
    if (server) server.close();
  });

  /** A separate browser profile, so a separate anonymous user. */
  async function player({ nickname = '', lang = 'en', viewport = DESKTOP, configured = true } = {}) {
    const context = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write'] });
    contexts.push(context);
    await context.addInitScript(({ api, key, nickname, lang, configured }) => {
      if (configured) localStorage.setItem('theMind.online.dev', JSON.stringify({ supabaseUrl: api, supabaseKey: key }));
      if (!localStorage.getItem('theMind.bgc.v1')) {
        localStorage.setItem('theMind.bgc.v1', JSON.stringify({ lang, tips: { welcome: 1 }, online: { nickname, activeRoomId: null } }));
      }
    }, { api: stack.api, key: stack.key, nickname, lang, configured });
    const p = { context, dialogs: [], errors: [], requests: [] };
    p.open = async (url) => {
      p.page = await context.newPage();
      p.page.on('dialog', (d) => { p.dialogs.push(d.message()); d.dismiss().catch(() => {}); });
      p.page.on('pageerror', (e) => p.errors.push(String(e.stack || e).split('\n').slice(0, 8).join(' | ')));
      p.page.on('request', (r) => p.requests.push(r.url()));
      await p.page.goto(url);
      return p.page;
    };
    return p;
  }

  const seatCount = (page) => page.locator('#lobbySeats .lobby-seat:not(.empty)').count();
  const waitSeats = (page, n, timeout = 5000) => page.waitForFunction(
    (n) => document.querySelectorAll('#lobbySeats .lobby-seat:not(.empty)').length === n, n, { timeout });
  const waitText = (page, selector, text, timeout = 5000) => page.waitForFunction(
    ([s, x]) => (document.querySelector(s) || {}).textContent?.includes(x), [selector, text], { timeout });
  const activeRoomId = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('theMind.bgc.v1')).online.activeRoomId);

  async function createRoom(p, nickname, opts = {}) {
    await p.open(base + '/');
    await p.page.click('#onlineBtn');
    await p.page.fill('#onlineNick', nickname);
    if (opts.mode) await p.page.click(`[data-mode="${opts.mode}"]`);
    const t0 = Date.now();
    await p.page.click('#onlineSubmit');
    await p.page.waitForFunction(() => /^[A-HJ-NP-Z2-9]{6}$/.test(document.querySelector('#lobbyCode')?.textContent || ''), null, { timeout: 5000 });
    return { code: await p.page.textContent('#lobbyCode'), ms: Date.now() - t0 };
  }

  async function joinByCode(p, nickname, typedCode) {
    if (!p.page) await p.open(base + '/#online');
    else await p.page.goto(base + '/#online');
    await p.page.click('[data-tab="join"]');
    await p.page.fill('#onlineNick', '');
    await p.page.locator('#onlineNick').pressSequentially(nickname);
    await p.page.fill('#onlineCode', '');
    await p.page.locator('#onlineCode').pressSequentially(typedCode);
    await p.page.click('#onlineSubmit');
  }

  function assertNoXss(...players) {
    for (const p of players) {
      assert.deepEqual(p.dialogs, [], 'no alert fired');
      assert.deepEqual(p.errors, [], 'no page error');
    }
  }

  it('AC3/AC4/AC5: create, share link, one-tap join, live updates, start rules, full room, host hand-over', async () => {
    // A creates a room; the lobby shows a valid code within 2 seconds.
    const A = await player();
    const { code, ms } = await createRoom(A, 'Ayşe');
    assert.ok(ms < 2000, `lobby with a code after ${ms} ms`);
    await waitSeats(A.page, 1);
    assert.equal(await A.page.locator('#lobbyStart').isDisabled(), true, 'Start is disabled with 1 player');
    await waitText(A.page, '#lobbyStatus', 'a game needs 2–4');
    const roomId = await activeRoomId(A.page);

    // The share link is origin + path + ?room=CODE.
    await A.page.click('[data-act="copyLink"]');
    const link = await A.page.evaluate(() => navigator.clipboard.readText());
    assert.equal(link, `${base}/?room=${code}`);
    await A.page.click('[data-act="copyCode"]');
    assert.equal(await A.page.evaluate(() => navigator.clipboard.readText()), code);

    // B (nickname saved) opens it: Join is filled in and focused, ?room= is gone from the address bar; one tap.
    const B = await player({ nickname: XSS_TYPED });
    await B.open(link);
    await B.page.waitForSelector('#onlineCode');
    assert.equal(await B.page.inputValue('#onlineCode'), code);
    assert.equal(new URL(B.page.url()).search, '');
    assert.equal(await B.page.evaluate(() => document.activeElement && document.activeElement.id), 'onlineSubmit');
    // A person needs a moment to tap; by then the page has loaded supabase-js and signed in.
    await B.page.waitForFunction(async () => !!(await window.MindOnlineClient.currentSession()), null, { timeout: 8000 });
    const t1 = Date.now();
    await B.page.keyboard.press('Enter');
    await Promise.all([waitSeats(A.page, 2, 3000), waitSeats(B.page, 2, 3000)]);
    const joinMs = Date.now() - t1;
    assert.ok(joinMs < 1000, `both lobbies show 2 players ${joinMs} ms after the tap`);
    await waitText(A.page, '#srLive', `${XSS_TYPED} joined the room`);

    // XSS: the nickname is plain text everywhere, no <img> is created and no alert fires.
    for (const p of [A, B]) {
      assert.equal(await p.page.locator('img').count(), 0);
      assert.ok((await p.page.locator('#lobbySeats').textContent()).includes(XSS_TYPED));
    }

    // Start needs everyone online; B is not the host.
    await A.page.waitForFunction(() => !document.querySelector('#lobbyStart').disabled, null, { timeout: 5000 });
    await waitText(A.page, '#lobbyStatus', 'Everyone is here');
    assert.equal(await B.page.locator('#lobbyStart').isHidden(), true);
    await waitText(B.page, '#lobbyStatus', 'Waiting for the host');
    assert.equal(await B.page.locator('#lobbyMode [data-mode]').count(), 0, 'only the host gets the mode picker');

    // A changes the mode; B sees it.
    await A.page.click('#lobbyMode [data-mode="blind"]');
    await waitText(B.page, '#lobbyMode .opt.on', 'Blind');
    await waitText(B.page, '#srLive', 'Mode changed: Blind');

    // B goes away (tab closed): A sees "away" and cannot start. B comes back through the Home banner.
    await B.page.close();
    await A.page.waitForFunction(() => document.querySelector('#lobbyStart').disabled, null, { timeout: 8000 });
    await waitText(A.page, '#lobbySeats', 'away');
    await waitText(A.page, '#lobbyStatus', 'everyone is online');
    await B.open(base + '/');
    await B.page.waitForSelector('#rejoinBtn', { timeout: 5000 });
    assert.ok((await B.page.textContent('#rejoinSlot')).includes(code));
    await B.page.click('#rejoinBtn');
    await waitSeats(B.page, 2);
    await A.page.waitForFunction(() => !document.querySelector('#lobbyStart').disabled, null, { timeout: 8000 });

    // B leaves; A sees 1 player.
    await B.page.click('[data-act="leave"]');
    await B.page.waitForSelector('#onlineForm');
    await waitSeats(A.page, 1);
    await waitText(A.page, '#srLive', 'left the room');

    // Someone with A's nickname (Turkish case folding) is refused.
    const C = await player();
    await joinByCode(C, 'AYŞE', code);
    await waitText(C.page, '#onlineErr', 'Name already taken in this room.');

    // B joins again by typing the code as "abc-234"; C types the full XSS nickname (the field keeps 16 characters).
    await joinByCode(B, XSS_TYPED, code.slice(0, 3).toLowerCase() + '-' + code.slice(3));
    await waitSeats(B.page, 2);
    await joinByCode(C, XSS, code.slice(0, 3) + ' ' + code.slice(3));
    await C.page.waitForSelector('#onlineErr:has-text("Name already taken")', { timeout: 5000 });
    await C.page.fill('#onlineNick', '');
    await C.page.locator('#onlineNick').pressSequentially(XSS.replace('img', 'svg'));
    await C.page.click('#onlineSubmit');
    await waitSeats(C.page, 3);
    const D = await player();
    await joinByCode(D, 'Deniz', code);
    await Promise.all([A, B, C, D].map((p) => waitSeats(p.page, 4)));

    // A fifth player sees "Room is full".
    const E = await player();
    await joinByCode(E, 'Ece', code);
    await waitText(E.page, '#onlineErr', 'Room is full.');

    // AC5: a signed-in non-member cannot join the room's private Presence channel, with the app's own client.
    const denied = await E.page.evaluate(async (roomId) => {
      const session = await window.MindOnlineClient.ensureSession();
      return new Promise((resolve) => {
        let presence = null;
        window.MindOnlineClient.subscribeRoom(roomId, session.user.id, {
          onChange() {},
          onPresence(state) { presence = state; },
          onStatus(status) { resolve({ status, presence }); },
        });
        setTimeout(() => resolve({ status: 'timeout', presence }), 8000);
      });
    }, roomId);
    assert.deepEqual(denied, { status: 'down', presence: null });

    // A leaves; B (the earliest remaining) becomes host and gets the Start button and the mode picker.
    await A.page.click('[data-act="leave"]');
    await waitSeats(B.page, 3);
    await B.page.waitForSelector('#lobbyStart:not([hidden])', { timeout: 5000 });
    await waitText(B.page, '#srLive', 'is now the host');
    const bSeat = B.page.locator('#lobbySeats .lobby-seat.you');
    assert.equal(await bSeat.locator('.crown').count(), 1);
    assert.equal(await B.page.locator('#lobbyMode [data-mode]').count(), 4);

    // Start works with 3 players online; everyone sees "Game starting…".
    await B.page.waitForFunction(() => !document.querySelector('#lobbyStart').disabled, null, { timeout: 8000 });
    await B.page.click('#lobbyStart');
    await Promise.all([B, C, D].map((p) => waitText(p.page, '#screen-lobby', 'Game starting…')));

    // A player of the running game who tries to open another room is offered their room back.
    await C.page.goto(base + '/#online');
    await C.page.click('[data-tab="create"]');
    await C.page.click('#onlineSubmit');
    await waitText(C.page, '#onlineErr', "You're already playing in another room.");
    await C.page.click('#onlineErr [data-act="rejoin"]');
    await waitText(C.page, '#screen-lobby', 'Game starting…');

    for (const p of [A, B, C, D, E]) assert.equal(await p.page.locator('img').count(), 0);
    assertNoXss(A, B, C, D, E);
  });

  it('errors: network failure shows "Can\'t reach the server" with a working retry', async () => {
    const F = await player({ nickname: 'Fikret' });
    await F.open(base + '/#online');
    await F.page.waitForFunction(async () => !!(window.MindOnlineClient && await window.MindOnlineClient.currentSession().catch(() => null)), null, { timeout: 8000 });
    await F.context.setOffline(true);
    await F.page.click('#onlineSubmit');
    await waitText(F.page, '#onlineErr', "Can't reach the server.");
    await F.context.setOffline(false);
    await F.page.click('#onlineErr [data-act="retry"]');
    await F.page.waitForSelector('#lobbyCode:text-matches("^[A-HJ-NP-Z2-9]{6}$")', { timeout: 5000 });
    await F.page.click('[data-act="leave"]');
    await F.page.waitForSelector('#onlineForm');
    assert.deepEqual(F.errors, []);
  });

  it('a late Create answer never pulls the player out of an offline game they started meanwhile (I5)', async () => {
    const G = await player({ nickname: 'Gül' });
    await G.open(base + '/#online');
    await G.page.evaluate(() => {
      const rooms = window.MindOnlineClient.rooms;
      window.MindOnlineClient.rooms = (...args) => new Promise((r) => setTimeout(r, 2500)).then(() => rooms(...args));
    });
    await G.page.click('#onlineSubmit');
    await G.page.click('#onlineForm [data-nav="home"]');
    await G.page.click('.cta [data-nav="setup"]');
    await G.page.click('#startBtn');
    await G.page.waitForSelector('#screen-game.active');
    await G.page.waitForTimeout(3500);
    assert.equal(await G.page.evaluate(() => window.App.screen), 'game');
    assert.ok(await G.page.evaluate(() => !!window.App.engine));
    assert.deepEqual(G.dialogs, []);
    // The room was created all the same, so Home offers it back.
    assert.ok(await activeRoomId(G.page));
    await G.page.evaluate(() => { window.App.teardownGame(); window.App.go('home'); });
    await G.page.waitForSelector('#rejoinBtn', { timeout: 5000 });
    await G.page.click('#rejoinBtn');
    await waitSeats(G.page, 1);
    await G.page.click('[data-act="leave"]');
    await G.page.waitForSelector('#onlineForm');
    assert.deepEqual(G.errors, []);
  });

  it('AC7: mobile 360×640 in Turkish: no sideways scrolling, every control reachable by keyboard', async () => {
    const M = await player({ lang: 'tr', viewport: MOBILE });
    await createRoom(M, 'Murat');
    await waitText(M.page, '#lobbyStatus', 'Oyuncu bekleniyor');
    assert.ok(await M.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow');
    const reached = new Set();
    await M.page.locator('#lobbyTitle').focus().catch(() => {});
    for (let i = 0; i < 40; i++) {
      await M.page.keyboard.press('Tab');
      reached.add(await M.page.evaluate(() => {
        const el = document.activeElement;
        return el ? el.dataset.act || el.dataset.mode || el.id || el.tagName : '';
      }));
    }
    for (const control of ['copyCode', 'copyLink', 'classic', 'reverse', 'blind', 'dual', 'leave']) {
      assert.ok(reached.has(control), `Tab reaches ${control}: ${[...reached].join(', ')}`);
    }
    await M.page.goto(base + '/#online');
    assert.ok(await M.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow on #online');
    await M.page.goto(base + '/#lobby');
    await waitSeats(M.page, 1);
    await M.page.click('[data-act="leave"]');
    await M.page.waitForSelector('#onlineForm');
    assert.deepEqual(M.errors, []);
  });

  it('I5: with online play set up, Home and an offline game still make no Supabase or CDN request', async () => {
    const O = await player();
    await O.open(base + '/');
    await O.page.click('.cta [data-nav="setup"]');
    await O.page.click('#startBtn');
    await O.page.waitForSelector('#screen-game.active');
    await O.page.waitForTimeout(1500);
    const remote = O.requests.filter((u) => !u.startsWith(base) && !u.startsWith('data:'));
    assert.deepEqual(remote, []);
    assert.deepEqual(O.errors, []);
  });

  it('screenshots of the lobby (desktop and mobile, TR and EN)', { skip: !SHOTS && 'set ONLINE_E2E_SCREENSHOTS=<dir>' }, async () => {
    // Viewport-sized captures: the page background is `fixed`, which a full-page capture cannot show below the fold.
    const shot = async (page, name, bottom) => {
      await page.evaluate((b) => window.scrollTo(0, b ? document.body.scrollHeight : 0), !!bottom);
      await page.screenshot({ path: path.join(SHOTS, name), animations: 'disabled' });
    };
    for (const lang of ['en', 'tr']) {
      const host = await player({ lang });
      const { code } = await createRoom(host, lang === 'tr' ? 'Ayşe' : 'Alex', { mode: 'dual' });
      const guest = await player({ lang, nickname: lang === 'tr' ? 'Deniz' : 'Sam', viewport: MOBILE });
      await guest.open(`${base}/?room=${code}`);
      await guest.page.waitForSelector('#onlineCode');
      await shot(guest.page, `join-mobile-${lang}.png`);
      await guest.page.click('#onlineSubmit');
      await Promise.all([waitSeats(host.page, 2), waitSeats(guest.page, 2)]);
      await host.page.waitForFunction(() => !document.querySelector('#lobbyStart').disabled, null, { timeout: 8000 });
      await shot(host.page, `lobby-desktop-${lang}.png`);
      await shot(guest.page, `lobby-mobile-${lang}.png`);
      await shot(guest.page, `lobby-mobile-${lang}-bottom.png`, true);
      await guest.page.click('[data-act="leave"]');
      await host.page.click('[data-act="leave"]');
    }
  });
});

describe('offline page from file:// (no stack needed)', { skip: !enabled && 'set ONLINE_E2E=1' }, () => {
  let browser;
  before(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
  });
  after(async () => { if (browser) await browser.close(); });

  it('AC1: Home → offline game makes no network request at all', async () => {
    const context = await browser.newContext({ viewport: DESKTOP });
    const page = await context.newPage();
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
    await page.click('.cta [data-nav="setup"]');
    await page.click('#startBtn');
    await page.waitForSelector('#screen-game.active');
    await page.waitForTimeout(1200);
    await page.keyboard.press('Space');
    await page.waitForTimeout(1500);
    assert.deepEqual(requests.filter((u) => !u.startsWith('file:') && !u.startsWith('data:')), []);
    assert.ok(requests.some((u) => u.endsWith('/online/online-lobby.js')), 'the local online scripts load from disk');
    await context.close();
  });

  it('AC2: with the empty committed config, Play online is disabled and says so in EN and TR', async () => {
    const context = await browser.newContext({ viewport: DESKTOP, locale: 'en-US' });
    const page = await context.newPage();
    await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
    await page.evaluate(() => { localStorage.clear(); });
    await page.reload();
    const btn = page.locator('#onlineBtn');
    assert.equal(await btn.isDisabled(), true);
    assert.equal(await page.textContent('#onlineOff'), "ℹ️ Online play isn't set up yet");
    assert.equal(await btn.getAttribute('aria-describedby'), 'onlineOff');
    await page.click('#langBtn');
    assert.equal(await page.locator('#onlineBtn').isDisabled(), true);
    assert.equal(await page.textContent('#onlineOff'), 'ℹ️ Çevrimiçi oyun henüz kurulmadı');
    await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '#online');
    await page.waitForSelector('#screen-online.active');
    assert.ok((await page.textContent('#screen-online')).includes('Çevrimiçi oyun henüz kurulmadı'));
    await context.close();
  });
});
