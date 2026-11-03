// MIND-06 · The online table in real browsers (Playwright, Chromium) against a local Supabase stack, with three
// browser profiles (three anonymous players). Covers AC1 synced play, AC2 mistake, AC3 star (yes, no, timeout),
// AC4 modes, AC5 disconnect / rejoin / resume / End game, AC6 reload, AC7 vote countdowns, AC9 XSS in game and 360×640.
// Skipped unless ONLINE_E2E=1:  npm run db:start && npx playwright install chromium && npm run test:e2e:game
// The API URL and anon key come from SUPABASE_E2E_URL / SUPABASE_E2E_ANON_KEY or `supabase status`; the database URL
// (used only to fast-forward a pause by 3 minutes) from ROOMS_TEST_DB_URL or the local default.
// ONLINE_E2E_RECORD=<dir> also saves frames of a 2-player online level (for the PR's GIF).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const enabled = process.env.ONLINE_E2E === '1';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECORD = process.env.ONLINE_E2E_RECORD || '';
const DB_URL = process.env.ROOMS_TEST_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const XSS = '<img src=x onerr'; // what the 16-character nickname field keeps of <img src=x onerror=alert(1)>
const DESKTOP = { width: 1180, height: 820 };
const MOBILE = { width: 360, height: 640 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function localStack() {
  if (process.env.SUPABASE_E2E_URL && process.env.SUPABASE_E2E_ANON_KEY) {
    return { api: process.env.SUPABASE_E2E_URL, key: process.env.SUPABASE_E2E_ANON_KEY };
  }
  const out = execFileSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const status = JSON.parse(out.slice(out.indexOf('{')));
  return { api: status.API_URL, key: status.ANON_KEY };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
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

describe('online table in the browser (local Supabase)', { skip: !enabled && 'set ONLINE_E2E=1 (npm run test:e2e:game) with a local stack running' }, () => {
  let browser, server, base, stack, A, B, C;

  before(async () => {
    const { chromium } = await import('playwright');
    stack = localStack();
    server = await startStaticServer();
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
    [A, B, C] = await Promise.all([player('Ayşe'), player('Bora'), player(XSS)]);
  });

  after(async () => {
    if (spreads.length) {
      const pct = (list, q) => list.slice().sort((x, y) => x - y)[Math.min(list.length - 1, Math.floor(list.length * q))];
      const b = spreads.map((x) => x.behind);
      const t = spreads.map((x) => x.total);
      console.log(`# AC1 over ${spreads.length} agreements – last client behind the first: p50 ${pct(b, 0.5)} ms, p90 ${pct(b, 0.9)} ms, max ${Math.max(...b)} ms; end to end: p50 ${pct(t, 0.5)} ms, p90 ${pct(t, 0.9)} ms, max ${Math.max(...t)} ms`);
    }
    if (browser) await browser.close();
    if (server) server.close();
  });

  async function player(nickname) {
    const context = await browser.newContext({ viewport: DESKTOP, permissions: ['clipboard-read', 'clipboard-write'] });
    await context.addInitScript(({ api, key, nickname }) => {
      localStorage.setItem('theMind.online.dev', JSON.stringify({ supabaseUrl: api, supabaseKey: key }));
      if (!localStorage.getItem('theMind.bgc.v1')) {
        localStorage.setItem('theMind.bgc.v1', JSON.stringify({ lang: 'en', sound: false, settings: { coach: false }, online: { nickname, activeRoomId: null } }));
      }
    }, { api: stack.api, key: stack.key, nickname });
    const p = { context, nickname, dialogs: [], errors: [] };
    p.open = async (url, viewport) => {
      const page = await context.newPage();
      if (viewport) await page.setViewportSize(viewport);
      page.on('dialog', (d) => { p.dialogs.push(d.message()); d.accept().catch(() => {}); });
      page.on('pageerror', (e) => p.errors.push(String(e.stack || e).split('\n').slice(0, 4).join(' | ')));
      await page.goto(url);
      p.page = page;
      return page;
    };
    return p;
  }

  /* ---------- reading the table ---------- */
  const view = (p) => p.page.evaluate(() => {
    const d = window.__mindOnlineDebug;
    if (!d || !d.publicState) return null;
    const ps = d.publicState;
    return {
      version: d.version, phase: ps.phase, level: ps.level, lives: ps.lives, stars: ps.stars,
      tops: ps.piles.map((x) => x.top), counts: ps.players.map((x) => x.handCount), discard: ps.discard.map((x) => x.v),
    };
  });
  // Wall-clock ms at which each client applied `version` (recorded in the page, so polling delays do not count).
  const appliedAt = (players, version) => Promise.all(players.map((p) => p.page.evaluate((v) => window.__mindOnlineDebug.appliedAt[v], version)));
  const handOf = (p) => p.page.$$eval('#hand .card[data-v]:not(.leaving)', (els) => els.map((e) => Number(e.dataset.v)));

  // Every client reaches the same version, newer than `after`, with the same level, lives, stars, pile tops, hand
  // counts and discard. Two limits:
  //   spread  AC1, the sync model: from the moment the first client applied that version until the last one did
  //           (the server is the referee; this is how fast its decision reaches everybody), at most 1 s. Each page
  //           records when it applied a version, so slow polling on a busy machine does not count;
  //   within  end to end from t0, which also includes the request and the server, plus SERVER_SLACK_MS. This one only
  //           catches hangs: the local edge runtime recycles a worker after 1 s of CPU in total, the next request pays
  //           a cold start, and on a busy machine a deadline tick can wait for that more than once. (Server speed is
  //           measured on the real project in MIND-07: PRD key result 3.)
  const SERVER_SLACK_MS = 5000;
  const spreads = [];
  async function converge(players, { after = -1, t0 = Date.now(), within = 1000, spread = 1000, phase } = {}) {
    const limit = within + SERVER_SLACK_MS;
    let snaps = [];
    for (;;) {
      snaps = await Promise.all(players.map(view));
      const same = snaps.every(Boolean) && snaps.every((s) => JSON.stringify(s) === JSON.stringify(snaps[0]));
      if (same && snaps[0].version > after && (!phase || snaps[0].phase === phase)) {
        const ms = Date.now() - t0;
        const at = await appliedAt(players, snaps[0].version);
        // Only a version that first appeared during this wait is measured: after a reload, the others had the current
        // version long before the reloaded page did.
        const fresh = at.every((x) => x != null) && Math.min(...at) >= t0 - 50;
        const behind = fresh ? Math.max(...at) - Math.min(...at) : 0;
        if (fresh) spreads.push({ behind, total: ms });
        assert.ok(behind <= spread, `the last client agreed ${behind} ms after the first (limit ${spread}): ${JSON.stringify(snaps[0])}`);
        assert.ok(ms <= limit, `clients agreed ${ms} ms after the action (limit ${limit}): ${JSON.stringify(snaps[0])}`);
        return snaps[0];
      }
      if (Date.now() - t0 > limit + 5000) assert.fail(`clients did not agree: ${JSON.stringify(snaps)}`);
      await sleep(20);
    }
  }



  const blur = (p) => p.page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());

  // One player's action, then AC1: all clients agree within 1 s of each other.
  async function act(players, actor, key, opts = {}) {
    const before = Math.max(...(await Promise.all(players.map(view))).map((s) => s.version));
    await blur(actor);
    const t0 = Date.now();
    await actor.page.keyboard.press(key);
    return converge(players, Object.assign({ after: before, t0 }, opts));
  }

  // The same, with a tap instead of a key (phone).
  async function tap(players, actor, selector, opts = {}) {
    const before = Math.max(...(await Promise.all(players.map(view))).map((s) => s.version));
    await actor.page.waitForSelector(selector, { state: 'visible' });
    const t0 = Date.now();
    // force: the hand button pulses, and Playwright would otherwise wait for it to stop moving before clicking.
    await actor.page.click(selector, { force: true });
    return converge(players, Object.assign({ after: before, t0 }, opts));
  }

  async function hands(players) {
    for (let i = 0; i < 100; i++) {
      const [hs, v] = [await Promise.all(players.map(handOf)), await view(players[0])];
      if (hs.reduce((n, h) => n + h.length, 0) === v.counts.reduce((n, c) => n + c, 0)) return hs;
      await sleep(30);
    }
    assert.fail('hands did not settle');
  }

  async function handsDown(players) {
    for (const p of players) await act(players, p, 'h');
    // The sync hold (1.4 s) ends with a client's tick.
    return converge(players, { phase: 'playing', within: 3500 });
  }

  async function playLowest(players) {
    const hs = await hands(players);
    const lowest = Math.min(...hs.flat());
    const actor = players[hs.findIndex((h) => h.includes(lowest))];
    return act(players, actor, 'Space');
  }

  async function playLevel(players) {
    let v = await handsDown(players);
    while (v.counts.some((n) => n > 0)) v = await playLowest(players);
    return converge(players, { phase: 'levelComplete', within: 3000 });
  }

  async function nextLevel(players, by) {
    await by.page.waitForSelector('#nextLvl', { timeout: 5000 });
    const v = await act(players, by, 'Enter');
    for (const p of players) await p.page.waitForSelector('#overlay[hidden]', { state: 'attached', timeout: 3000 });
    return v;
  }

  async function newRoom(host, guests, mode) {
    if (!host.page) await host.open(base + '/#online');
    else await host.page.goto(base + '/#online');
    await host.page.click('[data-tab="create"]');
    if (mode) await host.page.click(`#onlineForm [data-mode="${mode}"]`);
    await host.page.click('#onlineSubmit');
    await host.page.waitForFunction(() => /^[A-HJ-NP-Z2-9]{6}$/.test(document.querySelector('#lobbyCode')?.textContent || ''), null, { timeout: 8000 });
    const code = await host.page.textContent('#lobbyCode');
    for (const g of guests) {
      if (!g.page || g.page.isClosed()) await g.open(`${base}/?room=${code}`, g.viewport);
      else await g.page.goto(`${base}/?room=${code}`);
      await g.page.waitForSelector('#onlineCode');
      await g.page.waitForFunction(async () => !!(await window.MindOnlineClient.currentSession()), null, { timeout: 8000 });
      await g.page.click('#onlineSubmit');
      await g.page.waitForSelector('#lobbySeats .lobby-seat:not(.empty)', { timeout: 8000 });
    }
    await host.page.waitForFunction(() => !document.querySelector('#lobbyStart').disabled, null, { timeout: 10000 });
    await host.page.click('#lobbyStart');
    const players = [host, ...guests];
    for (const p of players) await p.page.waitForSelector('#screen-game.active', { timeout: 8000 });
    await converge(players, { phase: 'sync', within: 5000 });
    return players;
  }

  async function readVoteEnd(p) {
    return p.page.evaluate(() => {
      const m = /scaleX\(([\d.e-]+)\)/.exec(document.querySelector('#voteTimer').style.transform || '');
      return m ? Date.now() + Number(m[1]) * 12000 : null;
    });
  }

  function noXss(players) {
    for (const p of players) {
      assert.deepEqual(p.errors, [], `${p.nickname}: no page error`);
      assert.ok(p.dialogs.every((m) => /leave this game/i.test(m)), `${p.nickname}: only our own confirm dialogs: ${p.dialogs}`);
    }
  }

  it('AC1–AC3, AC5–AC7, AC9: three players play, mistake, stars, reload, disconnect, End game', { timeout: 240_000 }, async () => {
    const players = await newRoom(A, [B, C]);
    const roomId = await A.page.evaluate(() => JSON.parse(localStorage.getItem('theMind.bgc.v1')).online.activeRoomId);

    // AC9: the nickname with markup is text on every table.
    for (const p of players) {
      assert.equal(await p.page.locator('img').count(), 0);
      assert.equal(await p.page.textContent('#hudMode'), 'Classic · 🌐');
    }
    assert.deepEqual(await A.page.$$eval('#seats .seat .name', (els) => els.map((e) => e.textContent)), ['Bora', XSS]);
    assert.deepEqual(await B.page.$$eval('#seats .seat .name', (els) => els.map((e) => e.textContent)), [XSS, 'Ayşe']);
    assert.deepEqual(await C.page.$$eval('#seats .seat .name', (els) => els.map((e) => e.textContent)), ['Ayşe', 'Bora']);

    // AC1: Classic levels 1–2, every action agreed by all three within 1 s of each other.
    let v = await playLevel(players);
    assert.deepEqual([v.level, v.lives, v.stars], [1, 3, 1]);
    await nextLevel(players, C);
    v = await playLevel(players);
    assert.deepEqual([v.level, v.lives, v.stars], [2, 3, 2], 'a star after level 2');
    await nextLevel(players, B);

    // AC3: level 3 – a star everybody agrees to.
    await handsDown(players);
    let hs = await hands(players);
    const lowest = hs.map((h) => Math.min(...h));
    await act(players, A, 's', { phase: 'starVote' });
    // The proposer counts as yes; the others vote. Every client shows who proposed and the votes.
    for (const p of [B, C]) assert.match(await p.page.textContent('#voteQ'), /Ayşe raises a hand/);
    await act(players, B, 'y');
    v = await act(players, C, 'y');
    assert.equal(v.stars, 1);
    assert.deepEqual(v.discard.slice().sort((x, y) => x - y), lowest.slice().sort((x, y) => x - y), 'each player discards their lowest card');
    await converge(players, { phase: 'playing', within: 4000 });
    await sleep(1500); // discard animations
    for (const p of players) {
      const shown = await p.page.$$eval('#discardCards .card[data-v]', (els) => els.map((e) => Number(e.dataset.v)).sort((x, y) => x - y));
      assert.deepEqual(shown, lowest.slice().sort((x, y) => x - y), `${p.nickname} shows the same discarded cards`);
    }

    // AC3: one "no" rejects it for everybody.
    await act(players, A, 's', { phase: 'starVote' });
    v = await act(players, C, 'n', { phase: 'playing' });
    assert.equal(v.stars, 1);
    for (const p of players) await p.page.waitForFunction(() => /shook their head/.test(document.querySelector('#tableMsg').textContent), null, { timeout: 3000 });

    // AC3 + AC7: a non-voter times out to "no" after 12 s; the countdowns of two clients agree within 250 ms.
    const proposedAt = Date.now();
    await act(players, B, 's', { phase: 'starVote' });
    await act(players, A, 'y');
    await sleep(1000);
    for (let i = 0; i < 3; i++) {
      const [ea, eb, ec] = await Promise.all([A, B, C].map(readVoteEnd));
      assert.ok(Math.abs(ea - eb) < 250 && Math.abs(ea - ec) < 250, `vote countdowns differ: ${ea - eb} / ${ea - ec} ms`);
      await sleep(700);
    }
    v = await converge(players, { phase: 'playing', within: 16_000, t0: proposedAt });
    assert.ok(Date.now() - proposedAt >= 11_500, 'not before the 12 s deadline');
    assert.equal(v.stars, 1);

    // AC6: reloading during play restores the table within 3 s.
    const cHand = await handOf(C);
    const t0 = Date.now();
    await C.page.reload();
    await C.page.waitForSelector('#screen-game.active', { timeout: 3000 });
    await C.page.waitForFunction((n) => document.querySelectorAll('#hand .card[data-v]').length === n, cHand.length, { timeout: 3000 });
    assert.ok(Date.now() - t0 <= 3000, `table restored after ${Date.now() - t0} ms`);
    assert.deepEqual(await handOf(C), cHand);
    await converge(players, { within: 2000 });

    // AC2: a mistake – every client shows the same discarded cards and loses exactly 1 life, then syncs again.
    hs = await hands(players);
    const mins = hs.map((h) => Math.min(...h));
    const culprit = mins.indexOf(Math.max(...mins));
    const lower = hs.flatMap((h, i) => (i === culprit ? [] : h.filter((x) => x < mins[culprit])));
    v = await act(players, players[culprit], 'Space');
    assert.equal(v.lives, 2);
    assert.equal(v.discard.length, lowest.length + lower.length);
    assert.deepEqual(v.discard.slice(lowest.length).sort((x, y) => x - y), lower.sort((x, y) => x - y));
    v = await converge(players, { phase: 'sync', within: 4500 });
    assert.equal(v.lives, 2);
    await sleep(800);
    for (const p of players) {
      const shown = await p.page.$$eval('#discardCards .card[data-v]', (els) => els.map((e) => Number(e.dataset.v)).sort((x, y) => x - y));
      assert.deepEqual(shown, v.discard.slice().sort((x, y) => x - y), `${p.nickname} shows the same discard`);
      assert.equal(await p.page.locator('#hudLives .heart:not(.empty):not(.break)').count(), 2);
    }
    if (v.counts.some((n) => n > 0)) await handsDown(players);

    // AC5: B's tab closes during play; A and C pause within about 6 s, waiting for B.
    const bHand = await handOf(B);
    const closedAt = Date.now();
    await B.page.close();
    for (const p of [A, C]) {
      await p.page.waitForFunction(() => /Waiting for Bora/.test(document.querySelector('#olWaiting')?.textContent || ''), null, { timeout: 9000 });
    }
    const pausedAfter = Date.now() - closedAt;
    assert.ok(pausedAfter <= 8000, `paused after ${pausedAfter} ms`);
    assert.equal(await A.page.locator('#olResume').isDisabled(), true, 'nobody can resume while B is away');
    // B reopens the site: the Home banner takes B back to the same seat and the same hand.
    await B.open(base + '/');
    await B.page.click('#rejoinBtn', { timeout: 8000 });
    await B.page.waitForSelector('#screen-game.active', { timeout: 5000 });
    await B.page.waitForFunction((n) => document.querySelectorAll('#hand .card[data-v]').length === n, bHand.length, { timeout: 4000 });
    assert.deepEqual(await handOf(B), bHand);
    await A.page.waitForFunction(() => !document.querySelector('#olResume').disabled, null, { timeout: 5000 });
    v = await converge(players, { phase: 'paused', within: 3000 });
    await A.page.click('#olResume');
    v = await converge(players, { phase: 'sync', within: 2000 });
    for (const p of players) await p.page.waitForSelector('#overlay[hidden]', { state: 'attached', timeout: 2000 });
    assert.match(await A.page.textContent('#syncText'), /hands on the table/);

    // AC5: after 3 minutes paused, End game ends it for everybody. The pause is moved 3 minutes into the past.
    await act(players, A, 'p', { phase: 'paused' });
    const postgres = (await import('postgres')).default;
    const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
    try {
      await sql`update public.room_secrets set engine_state = jsonb_set(engine_state, '{pausedAt}', to_jsonb((engine_state->>'pausedAt')::bigint - 181000)) where room_id = ${roomId}`;
      await sql`update public.room_events set created_at = created_at - interval '181 seconds' where room_id = ${roomId} and seq = (select max(seq) from public.room_events where room_id = ${roomId} and type = 'paused')`;
    } finally {
      await sql.end();
    }
    assert.equal(await A.page.locator('#olEnd').isHidden(), true);
    await A.page.reload();
    await A.page.waitForSelector('#olEnd:not([hidden])', { timeout: 5000 });
    await A.page.click('#olEnd');
    for (const p of players) {
      await p.page.waitForSelector('#screen-home.active', { timeout: 5000 });
      await p.page.waitForFunction(() => /Game ended after a long pause/.test(document.querySelector('#toasts').textContent), null, { timeout: 3000 });
    }
    // The journal keeps the online game, with 🌐, the nicknames as text, and no badge.
    await C.page.goto(base + '/#journal');
    noXss(players);
    assert.equal(await C.page.locator('img').count(), 0);
  });

  it('AC4 + AC9: Reverse on a 360×640 phone to game over, rematch, Dual, Blind, reconnecting, a player leaving', { timeout: 180_000 }, async () => {
    // Reverse: one pile counting down. B plays on a phone, by tapping.
    B.viewport = MOBILE;
    if (B.page) await B.page.close();
    B.page = null;
    let players = await newRoom(A, [B], 'reverse');
    for (const p of players) {
      assert.deepEqual(await p.page.$$eval('#piles .pile', (els) => els.map((e) => e.className)), ['pile down']);
      assert.match(await p.page.textContent('#piles .pile .slot'), /100 → 1/);
    }
    assert.ok(await B.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scrolling at 360×640');
    // Two levels, each with a deliberate mistake, lose both lives: game over. In Reverse your playable card is your
    // highest; whoever's highest card is lower plays first, while the other still holds a higher card.
    for (const level of [1, 2]) {
      await tap(players, B, '#handBtn');
      await act(players, A, 'h');
      await converge(players, { phase: 'playing', within: 3500 });
      const [ha, hb] = await hands(players);
      const v = Math.max(...ha) < Math.max(...hb) ? await act(players, A, 'Space') : await tap(players, B, '#hand .card.playable');
      assert.equal(v.lives, 2 - level);
      if (level === 1) {
        await converge(players, { phase: 'levelComplete', within: 4500 });
        await nextLevel(players, A);
      }
    }
    await converge(players, { phase: 'gameOver', within: 4500 });
    // The offline game-over screen, from public_state.result; the host gets Rematch, everyone gets Leave.
    for (const p of players) await p.page.waitForSelector('#modal #leaveBtn', { timeout: 5000 });
    assert.equal(await A.page.textContent('#modal h2'), 'The mind link broke at level 2');
    assert.equal(await A.page.locator('#rematchBtn').count(), 1);
    assert.equal(await B.page.locator('#rematchBtn').count(), 0);
    assert.match(await B.page.textContent('#modal'), /The host can start a rematch/);
    assert.ok(await B.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'end screen fits 360 px');
    // The journal keeps it with 🌐 and the nicknames; no badge is unlocked online.
    const saved = await B.page.evaluate(() => JSON.parse(localStorage.getItem('theMind.bgc.v1')));
    assert.equal(saved.log[0].online, true);
    assert.deepEqual(saved.log[0].nicknames, ['Bora', 'Ayşe']);
    assert.equal(saved.log[0].won, false);
    assert.deepEqual(saved.badges, {});
    // Rematch: everyone goes back to the lobby, seated, and the host picks Dual.
    await A.page.click('#rematchBtn');
    for (const p of players) {
      await p.page.waitForFunction(() => window.App.screen === 'lobby' && !!document.querySelector('#screen-lobby.active #lobbySeats'), null, { timeout: 6000 });
    }
    for (const p of players) await p.page.waitForFunction(() => document.querySelectorAll('#lobbySeats .lobby-seat:not(.empty)').length === 2, null, { timeout: 5000 });
    await B.page.goto(base + '/#journal');
    assert.match(await B.page.textContent('table.log'), /Bora, Ayşe/);
    assert.equal(await B.page.locator('table.log .online-tag').count(), 1);
    await B.page.goto(base + '/#lobby');

    // Dual: two piles, one up and one down.
    await A.page.click('#lobbyMode [data-mode="dual"]');
    await B.page.waitForFunction(() => /Extreme/.test(document.querySelector('#lobbyMode .opt.on')?.textContent || ''), null, { timeout: 5000 });
    await A.page.waitForFunction(() => !document.querySelector('#lobbyStart').disabled, null, { timeout: 10000 });
    await A.page.click('#lobbyStart');
    for (const p of players) await p.page.waitForSelector('#screen-game.active', { timeout: 8000 });
    for (const p of players) {
      await p.page.waitForFunction(() => document.querySelectorAll('#piles .pile').length === 2, null, { timeout: 5000 });
      assert.deepEqual(await p.page.$$eval('#piles .pile', (els) => els.map((e) => [e.className, e.querySelector('.slot').textContent])), [['pile up', '▲1 → 100'], ['pile down', '▼100 → 1']]);
    }

    // Losing your own connection shows "Reconnecting…", and the table catches up once it is back.
    await B.context.setOffline(true);
    await B.page.waitForSelector('#netOverlay', { timeout: 3000 });
    assert.match(await B.page.textContent('#netOverlay'), /Reconnecting/);
    await act([A], A, 'h');
    await B.context.setOffline(false);
    await B.page.waitForSelector('#netOverlay', { state: 'detached', timeout: 8000 });
    await converge(players, { within: 3000 });

    // A leaves mid-game: B is told who left and goes back to Home.
    await A.page.click('.brand');
    await B.page.waitForFunction(() => /Game ended — Ayşe left/.test(document.querySelector('#toasts').textContent), null, { timeout: 5000 });
    await B.page.waitForSelector('#screen-home.active');

    // Blind: the other client sees a face-down card until the reveal, which then runs on both clients.
    B.viewport = null;
    await B.page.close();
    B.page = null;
    players = await newRoom(A, [B], 'blind');
    await handsDown(players);
    await act(players, B, 'Space');
    await A.page.waitForSelector('#piles .card.back', { timeout: 3000 });
    assert.equal(await A.page.locator('#piles .card:not(.back)').count(), 0, 'face down for the others');
    assert.equal(await A.page.textContent('#piles .card .num'), '');
    await act(players, A, 'Space');
    for (const p of players) {
      await p.page.waitForFunction(() => document.querySelectorAll('#piles .card:not(.back)[data-v]').length === 2, null, { timeout: 4000 });
    }
    await A.page.click('.brand');
    await B.page.waitForSelector('#screen-home.active', { timeout: 5000 });
    noXss([A, B]);
  });

  it('records frames of a 2-player online level', { skip: !RECORD && 'set ONLINE_E2E_RECORD=<dir>', timeout: 120_000 }, async () => {
    fs.mkdirSync(RECORD, { recursive: true });
    if (!A.page) await A.open(base + '/');
    await A.page.setViewportSize({ width: 960, height: 640 });
    const players = await newRoom(A, [B]);
    let recording = true;
    let n = 0;
    const loop = (async () => {
      while (recording) {
        const at = Date.now();
        await A.page.screenshot({ path: path.join(RECORD, `frame-${String(n++).padStart(4, '0')}-${at}.jpg`), type: 'jpeg', quality: 80, scale: 'css' });
      }
    })();
    await sleep(600);
    await playLevel(players);
    await nextLevel(players, A);
    await sleep(600);
    await playLevel(players);
    await sleep(2500);
    recording = false;
    await loop;
    await A.page.evaluate(() => window.App.go('home'));
  });
});
