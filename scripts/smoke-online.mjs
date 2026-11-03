#!/usr/bin/env node
/* Online smoke test (MIND-07): two anonymous players play Classic level 1 against a Supabase project, and every
 * room-action round trip is timed. Exits 1 when a step fails or when the p95 round trip is above the limit.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_PUBLISHABLE_KEY=sb_publishable_… node scripts/smoke-online.mjs
 *   SMOKE_MAX_P95_MS   p95 limit in ms (default 400, PRD key result 3)
 *
 * Steps: sign in two anonymous users → create, join, start Classic → both hands down → after each tick, read each
 * player's own room_hands row and let the holder of the lowest card play it (so there is no mistake) → level 1
 * complete → both leave. The first room-action call is a warm-up and is reported but not counted: it can include
 * the function's cold start, which a table pays once and not on every action.
 * Uses only the URL and the publishable key (I8); nothing secret is read or printed.
 */
import { createClient } from '@supabase/supabase-js';
import { readConfig, PackageError } from './package-site.mjs';

const MAX_P95_MS = Number(process.env.SMOKE_MAX_P95_MS || 400);
const REQUEST_TIMEOUT_MS = 10_000;
const TOTAL_TIMEOUT_MS = 90_000;
const MAX_TICKS = 40;

class SmokeError extends Error {}

// supabase-js needs a WebSocket on Node 20 even when Realtime is not used; this test never opens one.
class NoRealtime {
  constructor() {
    throw new Error('the smoke test does not use Realtime');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const ok = (msg) => console.log(`✓ ${msg}`);

export async function runSmoke({ supabaseUrl, supabaseKey, maxP95 = MAX_P95_MS, log = ok }) {
  const timings = [];
  let warmUp = null;
  const client = () => createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { transport: globalThis.WebSocket || NoRealtime },
  });
  const players = [{ name: 'Smoke A', db: client() }, { name: 'Smoke B', db: client() }];

  async function call(player, fn, body, { timed = false } = {}) {
    const started = performance.now();
    let res;
    try {
      res = await fetch(`${supabaseUrl}/functions/v1/${fn}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${player.token}`, apikey: supabaseKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new SmokeError(`${fn} ${body.action || body.type}: no answer (${err.name})`);
    }
    const json = await res.json().catch(() => null);
    const ms = Math.round(performance.now() - started);
    if (timed) {
      if (warmUp == null) warmUp = { type: body.type, ms };
      else timings.push({ type: body.type, ms });
    }
    return { status: res.status, body: json };
  }

  async function act(player, type, extra = {}) {
    const r = await call(player, 'room-action', { roomId, type, ...extra }, { timed: true });
    if (r.status !== 200 || !r.body || r.body.ok !== true) {
      const code = r.body && r.body.error ? r.body.error.code : `HTTP ${r.status}`;
      throw new SmokeError(`room-action ${type} by ${player.name} failed: ${code}`);
    }
    return r.body;
  }

  async function ownHand(player) {
    const { data, error } = await player.db.from('room_hands').select('user_id, hand').eq('room_id', roomId);
    if (error) throw new SmokeError(`reading ${player.name}'s hand failed: ${error.message}`);
    if (data.length > 1 || (data[0] && data[0].user_id !== player.userId)) throw new SmokeError('a player could read another player\'s hand (I2)');
    return data[0] ? data[0].hand.map((c) => c.v) : [];
  }

  // 1. Two anonymous players.
  for (const p of players) {
    const { data, error } = await p.db.auth.signInAnonymously();
    if (error || !data.session) throw new SmokeError(`anonymous sign-in failed: ${error ? error.message : 'no session'} (are anonymous sign-ins on?)`);
    p.token = data.session.access_token;
    p.userId = data.user.id;
  }
  log('signed in two anonymous players');

  // 2. Create, join, start.
  const [a, b] = players;
  const created = await call(a, 'rooms', { action: 'create', nickname: a.name, variant: 'classic' });
  if (created.status !== 200) throw new SmokeError(`rooms create failed: ${created.body && created.body.error ? created.body.error.code : created.status}`);
  const { roomId, code } = created.body;
  try {
    const joined = await call(b, 'rooms', { action: 'join', code, nickname: b.name });
    if (joined.status !== 200) throw new SmokeError(`rooms join failed: ${joined.body && joined.body.error ? joined.body.error.code : joined.status}`);
    await call(a, 'room-action', { roomId, type: 'tick' }, { timed: true }); // warm-up (the lobby answers INVALID_MOVE)
    let state = await act(a, 'start');
    if (state.view.phase !== 'sync' || state.view.level !== 1) throw new SmokeError(`start: expected the level 1 sync, got ${state.view.phase}`);
    log(`room ${code} created, joined and started (Classic)`);

    // 3. Hands down, then ticks; after each tick the holder of the lowest card plays it.
    for (const p of players) state = await act(p, 'handDown');
    const lives = state.view.lives;
    let plays = 0;
    for (let i = 0; i < MAX_TICKS && state.view.phase !== 'levelComplete'; i++) {
      if (state.nextDeadlineAt != null) await sleep(Math.max(0, state.nextDeadlineAt - state.serverNow) + 20);
      state = await act(a, 'tick');
      if (state.view.phase === 'playing') {
        const hands = await Promise.all(players.map(ownHand));
        const lowest = Math.min(...hands.flat());
        if (!Number.isFinite(lowest)) continue;
        const holder = players[hands.findIndex((h) => h.includes(lowest))];
        state = await act(holder, 'play');
        plays++;
      }
    }
    if (state.view.phase !== 'levelComplete') throw new SmokeError(`level 1 did not complete (phase ${state.view.phase})`);
    if (state.view.lives !== lives) throw new SmokeError('a mistake happened although the lowest card was always played first');
    log(`level 1 complete: ${plays} plays, no mistake`);
  } finally {
    // 4. Leave (also cleans up when a step failed).
    for (const p of players) await call(p, 'rooms', { action: 'leave', roomId }).catch(() => {});
  }
  log('both players left the room');

  const ms = timings.map((t) => t.ms).sort((x, y) => x - y);
  if (!ms.length) throw new SmokeError('no room-action call was timed');
  const result = { n: ms.length, p50: percentile(ms, 50), p95: percentile(ms, 95), max: ms[ms.length - 1], warmUp, timings, maxP95 };
  result.pass = result.p95 <= maxP95;
  return result;
}

async function main() {
  let config;
  try {
    config = readConfig(process.env);
  } catch (err) {
    if (err instanceof PackageError) {
      console.error(`::error title=Smoke test::${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  console.log(`Smoke test against ${config.supabaseUrl}`);
  const timer = setTimeout(() => {
    console.error(`::error title=Smoke test::did not finish within ${TOTAL_TIMEOUT_MS / 1000} s`);
    process.exit(1);
  }, TOTAL_TIMEOUT_MS);
  try {
    const r = await runSmoke(config);
    const byType = {};
    for (const t of r.timings) (byType[t.type] = byType[t.type] || []).push(t.ms);
    console.log(`room-action round trips: n=${r.n} · p50 ${r.p50} ms · p95 ${r.p95} ms · max ${r.max} ms (warm-up ${r.warmUp.ms} ms, not counted)`);
    console.log(`  ${Object.entries(byType).map(([k, v]) => `${k} ${v.join('/')}`).join(' · ')}`);
    if (!r.pass) {
      console.error(`::error title=Smoke test::p95 ${r.p95} ms is above ${r.maxP95} ms`);
      process.exitCode = 1;
    } else {
      console.log(`PASS: p95 ${r.p95} ms ≤ ${r.maxP95} ms`);
    }
  } catch (err) {
    console.error(`::error title=Smoke test::${err instanceof SmokeError ? err.message : err.stack || err}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
