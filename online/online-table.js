/* Online table (MIND-06): takes over from the lobby when the room starts, and runs the shared game on the existing
 * table UI through an online engine proxy (online/online-engine-proxy.js). It also handles Presence (a player gone
 * for 5 s pauses the table), the shared pause card, reconnecting, the end of the game (rematch / leave), a game
 * that ends early, and the e2e debug hook. Nicknames only reach the page as text (I7). Sets window.MindOnlineTable,
 * which online-lobby.js calls. */
(function (global) {
  'use strict';

  const App = global.App;
  const UI = global.UI;
  const Core = global.MindOnlineCore;
  const Client = global.MindOnlineClient;
  const Sync = global.MindOnlineSync;
  const ProxyLib = global.MindOnlineProxy;
  const Mind = global.Mind;
  if (!App || !UI || !Core || !Client || !Sync || !ProxyLib || !Mind || !global.MindData) return;

  const { I18N } = global.MindData;
  const t = (k, v) => I18N.t(k, v);
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = Core.esc;
  const now = () => global.performance.now();
  const WATCH_MS = 500;
  const PAUSE_RESEND_MS = 3000;
  const END_CHECK_MS = 2500;
  // A neutral avatar: the same face for everybody, in the seat's color.
  const LOOK = { skin: '#e7bd95', hair: '#2a2342', style: 'short', hand: '✋' };

  const T = {
    token: 0, proxy: null, sub: null, roomId: null, userId: null, players: [], presence: {}, missing: new Map(),
    conn: 'idle', netDown: false, watch: null, pauseSentAt: 0, modal: null, ending: false,
  };

  function clearActive(roomId) {
    const o = global.Store && global.Store.data && global.Store.data.online;
    if (o && roomId && o.activeRoomId === roomId) {
      o.activeRoomId = null;
      global.Store.save();
    }
  }

  function sr(text) {
    const live = $('#srLive');
    if (live) live.textContent = text;
  }

  const nickname = (userId) => (T.players.find((p) => p.user_id === userId) || {}).nickname || '';
  const playerName = (pid) => (T.proxy && T.proxy.player(pid) ? T.proxy.player(pid).name : '');

  function buildMeta(proxy) {
    const players = {};
    for (const p of proxy.players) {
      players[p.id] = { name: p.name, human: p.human, role: '', look: Object.assign({ color: Sync.seatColor(p) }, LOOK) };
    }
    return { players, you: players[proxy.me] };
  }

  /* ---------- reconnecting overlay ---------- */
  function updateOverlay() {
    const show = !!T.proxy && (T.conn === 'down' || T.netDown);
    let el = $('#netOverlay');
    if (show && !el) {
      el = document.createElement('div');
      el.id = 'netOverlay';
      el.className = 'net-overlay';
      el.setAttribute('role', 'alert');
      el.innerHTML = `<div class="box"><span aria-hidden="true">📡</span><span>${t('online.game.reconnecting')}</span></div>`;
      document.body.appendChild(el);
    } else if (!show && el) {
      el.remove();
    }
  }

  function connStatus(status) {
    const was = T.conn;
    T.conn = status;
    if (status === 'live') {
      T.missing = new Map();
      if (was === 'down' && T.proxy) T.proxy.resync('reconnect');
    }
    updateOverlay();
  }

  /* ---------- the shared pause card ---------- */
  // Seated players who are not in Presence right now.
  function missingNames() {
    return Array.from(T.missing.keys()).map(nickname).filter(Boolean);
  }

  function openPause() {
    T.modal = 'pause';
    App.openModal(`
      <div class="online-pause">
        <div class="big-ico">⏸</div>
        <h2>${t('pause.title')}</h2>
        <p class="waiting" id="olWaiting" role="status"></p>
        <p class="muted" id="olPausedBy"></p>
        <p class="muted">${t('online.game.resumeHint')}</p>
        <p class="muted" id="olEndHint" hidden>${t('online.game.endGameHint')}</p>
        <div class="row">
          <button class="btn big hot" id="olResume" data-primary>▶ ${t('pause.resume')}</button>
          <button class="btn big ghost" id="olEnd" hidden>⏹ ${t('online.game.endGame')}</button>
          <button class="btn big ghost" id="olLeave">🚪 ${t('online.lobby.leave')}</button>
        </div>
      </div>`);
    $('#olResume').onclick = () => hooks.resume();
    $('#olEnd').onclick = () => {
      if (T.proxy && T.proxy.endGame()) $('#olEnd').classList.add('pressed');
    };
    $('#olLeave').onclick = () => {
      if (global.confirm(t('online.lobby.confirmLeaveGame'))) hooks.leave();
    };
    updatePause();
  }

  function updatePause() {
    const p = T.proxy;
    if (T.modal !== 'pause' || !p || !$('#olResume')) return;
    const names = missingNames();
    $('#olWaiting').textContent = names.length ? t('online.game.waitingFor', { names: names.join(', ') }) : '';
    const by = p.pausedBy;
    $('#olPausedBy').textContent = !names.length && by ? t('online.game.pausedBy', { name: UI.name(by) }) : '';
    $('#olResume').disabled = names.length > 0;
    const canEnd = p.canEndGame(now());
    $('#olEnd').hidden = !canEnd;
    $('#olEndHint').hidden = !canEnd;
  }

  function closePause() {
    if (T.modal !== 'pause') return;
    T.modal = null;
    App.closeModal();
  }

  function syncPause() {
    const p = T.proxy;
    if (!p) return;
    if (p.phase === 'paused' && T.modal !== 'pause') openPause();
    else if (p.phase !== 'paused') closePause();
  }

  /* ---------- presence: pause when a player is gone for 5 s ---------- */
  function watch() {
    const p = T.proxy;
    if (!p) return;
    const t0 = now();
    const live = T.conn === 'live' && !T.netDown;
    const others = T.players.filter((x) => x.user_id !== T.userId).map((x) => x.user_id);
    T.missing = live ? Sync.trackMissing(T.missing, others, Core.onlineUserIds(T.presence), t0) : new Map();
    if (live && p.status === 'playing' && Sync.shouldPause(p.phase, T.missing, t0) && t0 - T.pauseSentAt > PAUSE_RESEND_MS) {
      T.pauseSentAt = t0;
      // A little jitter, so the clients that notice together rarely all send it.
      setTimeout(() => {
        if (T.proxy === p && Sync.shouldPause(p.phase, T.missing, now())) p.pause();
      }, Math.random() * 400);
    }
    updatePause();
    updateOverlay();
  }

  async function refreshPlayers() {
    const roomId = T.roomId;
    try {
      const snap = await Client.fetchRoom(roomId);
      if (snap && T.roomId === roomId) T.players = snap.players;
    } catch (e) { /* the next change or resync tries again */ }
  }

  /* ---------- leaving, the end, and a game that ends early ---------- */
  function leaveRoom() {
    const roomId = T.roomId;
    if (!roomId) return;
    Client.rooms('leave', { roomId }).then(() => clearActive(roomId), (e) => {
      if (e && e.code === 'ROOM_NOT_FOUND') clearActive(roomId);
    });
  }

  function backToLobby() {
    if (T.ending) return;
    T.ending = true;
    App.teardownGame();
    App.go('lobby');
  }

  function aborted(d) {
    if (T.ending) return;
    T.ending = true;
    const name = d && d.by ? playerName(d.by) : '';
    const msg = d && d.reason === 'left' && name
      ? t('online.game.aborted', { name })
      : d && d.reason === 'endGame' ? t('online.game.endedPause') : t('online.game.closed');
    clearActive(T.roomId);
    App.teardownGame();
    App.go('home');
    App.toast(esc(msg));
    sr(msg);
  }

  function onRoomStatus(status) {
    const p = T.proxy;
    if (!p) return;
    if (status === 'lobby') backToLobby();
    else if (status === 'abandoned' || status === 'gone') {
      // The gameAborted event usually explains it first; this covers a room closed without one.
      setTimeout(() => { if (T.proxy === p) aborted(null); }, 600);
    } else if (status === 'finished') {
      // victory / gameOver show the end; if those events were missed, show it from the state.
      setTimeout(() => {
        if (T.proxy === p && !App.ended && p.result) App.onEnd(!!p.result.won);
      }, END_CHECK_MS);
    }
  }

  const hooks = {
    // Leaving the table screen (nav, logo, back): during play it ends the game for everyone, so ask first.
    quit() {
      const p = T.proxy;
      if (p && p.status === 'playing' && !App.ended && !global.confirm(t('online.lobby.confirmLeaveGame'))) return false;
      leaveRoom();
      return true;
    },
    resume() {
      if (T.proxy && !missingNames().length && T.proxy.resume()) {
        const b = $('#olResume');
        if (b) b.classList.add('pressed');
      }
    },
    rematch() {
      if (T.proxy) T.proxy.rematch();
    },
    leave() {
      leaveRoom();
      clearActive(T.roomId);
      App.teardownGame();
      App.go('home');
    },
    teardown() {
      stop();
    },
  };

  function onActionDone(d) {
    if (d.ok) {
      T.netDown = false;
      updateOverlay();
      return;
    }
    if (d.type === 'nextLevel') {
      const b = $('#nextLvl');
      if (b) { b.disabled = false; b.classList.remove('pressed'); }
    }
    if (d.type === 'rematch') {
      const b = $('#rematchBtn');
      if (b) { b.disabled = false; b.classList.remove('pressed'); }
    }
    if (d.type === 'resume' || d.type === 'endGame') {
      for (const id of ['#olResume', '#olEnd']) { const b = $(id); if (b) b.classList.remove('pressed'); }
    }
    if (d.code === 'NETWORK') {
      T.netDown = true;
      updateOverlay();
    } else if (d.code === 'NOT_A_MEMBER') {
      aborted(null);
    }
  }

  function wire(proxy) {
    proxy.on('refresh', () => {
      UI.refresh();
      syncPause();
    });
    proxy.on('paused', () => openPause());
    proxy.on('resumed', () => closePause());
    proxy.on('gameAborted', (d) => aborted(d));
    proxy.on('rematch', () => backToLobby());
    proxy.on('status', (d) => onRoomStatus(d.status));
    proxy.on('actionDone', onActionDone);
    proxy.on('netError', () => {
      T.netDown = true;
      updateOverlay();
    });
    proxy.on('resynced', () => {
      T.netDown = false;
      updateOverlay();
      syncPause();
    });
  }

  /* ---------- debug hook for e2e tests (dev override only): never a hand ---------- */
  function installDebug() {
    if (!Client.devOverride()) return;
    const hook = {};
    for (const k of ['version', 'publicState', 'seq', 'status', 'appliedAt']) {
      Object.defineProperty(hook, k, { enumerable: true, get: () => (T.proxy ? T.proxy.debug()[k] : null) });
    }
    global.__mindOnlineDebug = Object.freeze(hook);
  }

  /* ---------- start and stop ---------- */
  function stop() {
    clearInterval(T.watch);
    T.watch = null;
    if (T.sub) T.sub.unsubscribe();
    T.sub = null;
    if (T.proxy) T.proxy.dispose();
    T.proxy = null;
    T.missing = new Map();
    T.presence = {};
    T.modal = null;
    T.conn = 'idle';
    T.netDown = false;
    T.pauseSentAt = 0;
    T.ending = false;
    updateOverlay();
    try {
      delete global.__mindOnlineDebug;
    } catch (e) { /* not configurable in some engines */ }
  }

  async function start(info, token) {
    if (App.online) App.teardownGame();
    stop();
    const mine = (info.players || []).find((p) => p.user_id === info.userId);
    if (!mine) return;
    T.roomId = info.roomId;
    T.userId = info.userId;
    T.players = info.players.slice();
    const roomId = info.roomId;
    const userId = info.userId;
    const proxy = ProxyLib.create({
      Mind, Sync, roomId, userId, me: 's' + mine.seat,
      transport: {
        action: (type, input) => Client.roomActionRaw(roomId, type, input),
        snapshot: () => Client.fetchTable(roomId, userId),
        since: (afterSeq) => Client.fetchSince(roomId, userId, afterSeq),
      },
    });
    T.proxy = proxy;
    try {
      // Listen first, so nothing is missed while the snapshot loads.
      T.sub = await Client.subscribeRoom(roomId, userId, {
        onRoom: (row) => proxy.ingestRoomRow(row),
        onHand: (row) => proxy.ingestHandRow(row),
        onEvent: (row) => proxy.ingestEventRow(row),
        onPlayers: () => refreshPlayers(),
        onVersion: (v) => proxy.noteVersion(v),
        onPresence: (state) => { T.presence = state; },
        onStatus: (status) => { if (T.proxy === proxy) connStatus(status); },
      });
      if (token !== T.token) throw new Error('superseded');
      const snap = await proxy.prepare();
      if (token !== T.token) throw new Error('superseded');
      T.players = snap.players;
    } catch (err) {
      if (T.proxy === proxy) stop();
      if (token === T.token && err && err.message !== 'superseded') {
        App.toast(esc(t(Core.errorKey(err.code || 'NETWORK'))));
        if (App.screen === 'lobby') App.go('home');
      }
      return;
    }
    // Only take over from the lobby; a player who has moved on is not pulled back in.
    if (App.screen !== 'lobby' || !['playing', 'finished'].includes(proxy.status)) {
      const status = proxy.status;
      stop();
      if (App.screen === 'lobby' && status === 'lobby') App.render('lobby');
      return;
    }
    App.startOnlineGame(proxy, buildMeta(proxy), hooks);
    wire(proxy);
    proxy.begin();
    if (proxy.status === 'finished' && proxy.result) {
      App.ended = true;
      App.showEnd(!!proxy.result.won, { id: null });
    }
    syncPause();
    T.watch = setInterval(watch, WATCH_MS);
    installDebug();
  }

  /** Called by the lobby once, when the room becomes playing (or is finished on a reload). */
  function enter(info) {
    if (!info || !Core.isUuid(info.roomId) || !Core.isUuid(info.userId)) return;
    if (T.proxy && T.roomId === info.roomId) return;
    const token = ++T.token;
    setTimeout(() => start(info, token), 0);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && T.proxy) T.proxy.resync('visible');
  });
  global.addEventListener('online', () => {
    if (T.proxy) T.proxy.resync('online');
  });
  global.addEventListener('offline', () => {
    if (!T.proxy) return;
    T.netDown = true;
    updateOverlay();
  });

  global.MindOnlineTable = { enter, resume: () => hooks.resume() };
})(window);
