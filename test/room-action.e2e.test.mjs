// MIND-04 AC7 · Two anonymous users play Classic level 1 through HTTP, against a local Supabase stack
// (gateway, Auth, PostgREST and the edge runtime serving the functions).
// Skipped unless SUPABASE_E2E=1:  npm run db:start && npm run test:e2e
// The API URL and the publishable (anon) key come from SUPABASE_E2E_URL / SUPABASE_E2E_ANON_KEY, or else from
// `supabase status`. Nothing else is read, and nothing is printed.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const enabled = process.env.SUPABASE_E2E === '1';

function localStack() {
  if (process.env.SUPABASE_E2E_URL && process.env.SUPABASE_E2E_ANON_KEY) {
    return { api: process.env.SUPABASE_E2E_URL, key: process.env.SUPABASE_E2E_ANON_KEY };
  }
  const out = execFileSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const status = JSON.parse(out.slice(out.indexOf('{')));
  return { api: status.API_URL, key: status.ANON_KEY };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('room-action over HTTP (local Supabase)', { skip: !enabled && 'set SUPABASE_E2E=1 (npm run test:e2e) with a local stack running' }, () => {
  let api, key;
  before(() => ({ api, key } = localStack()));

  async function signIn() {
    const res = await fetch(`${api}/auth/v1/signup`, {
      method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: '{}',
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.user.is_anonymous, true);
    return body.access_token;
  }
  async function fn(name, token, body) {
    const res = await fetch(`${api}/functions/v1/${name}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json(), headers: res.headers };
  }
  async function act(token, roomId, type, extra = {}) {
    const r = await fn('room-action', token, { roomId, type, ...extra });
    assert.equal(r.status, 200, `${type}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
    return r.body;
  }
  async function rest(token, path, init = {}) {
    const res = await fetch(`${api}/rest/v1/${path}`, {
      ...init, headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    return { status: res.status, body: await res.json() };
  }

  it('two players start, sync, play level 1 in order and see only their own hand', async () => {
    const [host, guest, stranger] = await Promise.all([signIn(), signIn(), signIn()]);
    const created = await fn('rooms', host, { action: 'create', nickname: 'Host', variant: 'classic' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const { roomId, code } = created.body;
    assert.equal((await fn('rooms', guest, { action: 'join', code, nickname: 'Guest' })).status, 200);

    const started = await fn('room-action', host, { roomId, type: 'start' });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.match(started.headers.get('server-timing'), /load;dur=.*engine;dur=.*commit;dur=.*total;dur=/);
    assert.equal(started.body.status, 'playing');
    assert.deepEqual([started.body.view.level, started.body.view.phase, started.body.view.you], [1, 'sync', 's0']);
    assert.equal(started.body.view.hand.length, 1);
    assert.equal(typeof started.body.serverNow, 'number');

    // A stranger is not seated; clients cannot call the commit function themselves (I3).
    assert.equal((await fn('room-action', stranger, { roomId, type: 'tick' })).body.error.code, 'NOT_A_MEMBER');
    const direct = await rest(guest, 'rpc/commit_room_action', {
      method: 'POST',
      body: JSON.stringify({ p_room_id: roomId, p_expected_version: 0, p_engine_state: null, p_hands: [], p_events: [], p_public_state: null, p_status: 'finished', p_next_deadline_at: null }),
    });
    assert.ok(direct.status === 401 || direct.status === 403 || direct.status === 404, `direct RPC answered ${direct.status}`);
    const peek = await rest(guest, 'rpc/load_room_for_action', {
      method: 'POST', body: JSON.stringify({ p_room_id: roomId, p_user_id: (await (await fetch(`${api}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${guest}` } })).json()).id }),
    });
    assert.ok(peek.status === 401 || peek.status === 403 || peek.status === 404, `loading the hidden state answered ${peek.status}`);
    assert.ok(!JSON.stringify(peek.body).includes('rngState'));

    await act(host, roomId, 'handDown');
    const down = await act(guest, roomId, 'handDown');
    assert.equal(down.view.phase, 'sync');
    assert.ok(down.nextDeadlineAt > down.serverNow);
    await sleep(down.nextDeadlineAt - down.serverNow + 150);
    const ticked = await act(guest, roomId, 'tick');
    assert.equal(ticked.view.phase, 'playing');

    // Each player reads only their own hand row (RLS) and it matches the view the function sent them.
    const hands = {};
    for (const [token, seat] of [[host, 's0'], [guest, 's1']]) {
      const rows = (await rest(token, 'room_hands?select=user_id,hand')).body;
      assert.equal(rows.length, 1);
      hands[seat] = { token, v: rows[0].hand[0].v };
    }
    const view = (await act(host, roomId, 'tick')).view;
    assert.deepEqual(view.hand.map((c) => c.v), [hands.s0.v]);
    assert.deepEqual(view.players.map((p) => p.handCount), [1, 1]);

    const order = Object.values(hands).sort((a, b) => a.v - b.v);
    await act(order[0].token, roomId, 'play');
    const last = await act(order[1].token, roomId, 'play');
    assert.equal(last.view.phase, 'levelComplete');
    assert.equal(last.view.lives, 2);
    assert.equal(last.events[0].type, 'play');
    assert.equal(last.events[last.events.length - 1].type, 'levelComplete');

    const [room] = (await rest(guest, `rooms?select=status,version,public_state&id=eq.${roomId}`)).body;
    assert.equal(room.status, 'playing');
    assert.equal(room.version, last.version);
    assert.equal(room.public_state.phase, 'levelComplete');
    assert.equal(room.public_state.hand, null);
    const events = (await rest(host, `room_events?select=seq,type&room_id=eq.${roomId}&order=seq`)).body;
    assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
    assert.ok(events.some((e) => e.type === 'levelComplete'));
    assert.deepEqual((await rest(stranger, `room_events?select=seq&room_id=eq.${roomId}`)).body, []);

    assert.equal((await fn('rooms', host, { action: 'leave', roomId })).status, 200);
    assert.equal((await fn('room-action', guest, { roomId, type: 'tick' })).body.error.code, 'INVALID_MOVE');
  });
});
