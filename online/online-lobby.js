/* Online lobby UI (MIND-05): the "Play online" entry and the rejoin banner on Home, the #online screen (create or join
 * a room) and the #lobby screen (code and share link, seats with presence, mode, start, leave).
 * Nicknames reach the page only through textContent or esc() (I7). Nothing here touches the network before the player
 * enters online mode or has a room to rejoin (I5). Sets window.MindOnlineLobby, which App calls. */
(function (global) {
  'use strict';

  const App = global.App;
  const Core = global.MindOnlineCore;
  const Client = global.MindOnlineClient;
  if (!App || !Core || !Client || !global.MindData) return;

  const { I18N } = global.MindData;
  const t = (k, v) => I18N.t(k, v);
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = Core.esc;
  const sound = () => global.Sound || { click() {} };
  const REFRESH_DELAY_MS = 60;

  const S = {
    // #online form
    tab: 'create', nickname: null, code: '', variant: 'classic', focusJoin: false, notice: null,
    // shared by both screens
    busy: false, error: null, retry: null,
    // #lobby
    roomId: null, room: null, players: null, presence: {}, me: null, conn: 'idle', sub: null,
    token: 0, fetchSeq: 0, refreshTimer: null, modeKey: null, handedOff: false,
  };

  /* ---------- saved state (Store: theMind.bgc.v1 → online) ---------- */
  function saved() {
    if (!Store.data.online) Store.data.online = { nickname: '', activeRoomId: null };
    return Store.data.online;
  }
  const activeRoomId = () => (Core.isUuid(saved().activeRoomId) ? saved().activeRoomId : null);
  function setActiveRoom(roomId) {
    saved().activeRoomId = roomId;
    Store.save();
  }
  function clearActiveRoom(roomId) {
    if (roomId && saved().activeRoomId !== roomId) return;
    saved().activeRoomId = null;
    Store.save();
  }
  function saveNickname(nickname) {
    saved().nickname = nickname;
    Store.save();
  }

  /* ---------- shared helpers ---------- */
  function sr(text) {
    const live = $('#srLive');
    if (!live) return;
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 50);
  }

  function errorHtml(err, retryable) {
    if (!err) return '';
    let html = `<span>⚠️ ${t(Core.errorKey(err.code))}</span>`;
    if (err.code === 'ALREADY_IN_GAME' && Core.isUuid(err.roomId)) {
      html += ` <button type="button" class="btn small good" data-act="rejoin" data-room="${esc(err.roomId)}">↩ ${t('online.rejoin.btn')}</button>`;
    } else if (retryable && Core.isRetryable(err.code)) {
      html += ` <button type="button" class="btn small ghost" data-act="retry">↻ ${t('online.retry')}</button>`;
    }
    return html;
  }

  // Runs one server call with a busy state; a failure becomes S.error, with `retry` behind the "Try again" button.
  // The task may return the screen to go to next, which only happens if the player is still where they started: a late
  // answer must never pull them out of an offline game (I5).
  async function run(task, retry) {
    if (S.busy) return;
    const from = App.screen;
    S.busy = true;
    S.error = null;
    S.retry = retry || null;
    repaint();
    let next = null;
    try {
      next = await task();
    } catch (e) {
      S.error = Client.toError(e);
    }
    S.busy = false;
    if (App.screen !== from) {
      clearError();
      repaint();
      if (next && App.screen === 'home') bindHome();
      return;
    }
    if (next) App.go(next);
    else repaint();
  }

  function repaint() {
    paintForm();
    paintLive();
  }

  function clearError() {
    S.error = null;
    S.retry = null;
  }

  function rejoin(roomId) {
    if (!Core.isUuid(roomId)) return;
    setActiveRoom(roomId);
    S.error = null;
    S.notice = null;
    App.go('lobby');
  }

  const modeCard = (id, ico, on, button) => {
    const attrs = button ? `type="button" data-mode="${id}" aria-pressed="${on}"` : '';
    const tag = button ? 'button' : 'div';
    return `<${tag} ${attrs} class="opt ${on ? 'on' : ''} ${button ? '' : 'static'}">
        <span class="ico" aria-hidden="true">${ico}</span>
        <span><b>${t('mode.' + id + '.t')}</b><small>${t('mode.' + id + '.b')}</small></span>
      </${tag}>`;
  };

  /* ---------- Home: entry, "not set up" note, rejoin banner ---------- */
  function homeButton() {
    const label = `🌐 ${t('online.home.play')}`;
    if (Client.configured()) return `<button class="btn big good" id="onlineBtn" data-nav="online">${label}</button>`;
    return `<button class="btn big good" id="onlineBtn" disabled aria-describedby="onlineOff">${label}</button>`;
  }

  function homeNote() {
    return Client.configured() ? '' : `<p class="muted small online-note" id="onlineOff">ℹ️ ${t('online.home.off')}</p>`;
  }

  const homeBanner = () => '<div id="rejoinSlot"></div>';

  let rejoinSeq = 0;
  // Only runs when an earlier online visit left a room behind; otherwise Home makes no request at all (I5).
  async function bindHome() {
    const roomId = activeRoomId();
    if (!roomId || !Client.configured()) return;
    const seq = ++rejoinSeq;
    try {
      const session = await Client.currentSession();
      if (!session) {
        clearActiveRoom(roomId);
        return;
      }
      const snap = await Client.fetchRoom(roomId);
      const seated = snap && Core.isActiveStatus(snap.room.status) && snap.players.some((p) => p.user_id === session.user.id);
      if (!seated) {
        clearActiveRoom(roomId);
        return;
      }
      const slot = $('#rejoinSlot');
      if (seq !== rejoinSeq || App.screen !== 'home' || !slot) return;
      slot.innerHTML = `
        <div class="panel rejoin" role="region" aria-label="${t('online.rejoin.btn')}">
          <span>🌐 ${t('online.rejoin.text', { code: '<b>' + esc(snap.room.code) + '</b>' })}</span>
          <button type="button" class="btn good" id="rejoinBtn">↩ ${t('online.rejoin.btn')}</button>
        </div>`;
      $('#rejoinBtn').onclick = () => {
        sound().click();
        rejoin(roomId);
      };
    } catch (e) { /* unreachable: no banner, and the room stays saved for later */ }
  }

  /* ---------- share link: ?room=CODE opens Join with the code filled in ---------- */
  function boot() {
    const code = Core.parseRoomParam(global.location.search);
    if (code == null) return null;
    try {
      global.history.replaceState(global.history.state, '', Core.withoutRoomParam(global.location.href));
    } catch (e) { /* some file:// pages refuse it; the link still works */ }
    S.tab = 'join';
    S.code = code;
    S.error = null;
    S.notice = null;
    S.focusJoin = true;
    return 'online';
  }

  /* ---------- #online: create or join ---------- */
  function renderOnline() {
    const root = $('#screen-online');
    if (S.nickname == null) S.nickname = saved().nickname || '';
    if (!Client.configured()) {
      root.innerHTML = `
        <div class="wrap online-wrap">
          <h2 id="onlineTitle">🌐 ${t('online.title')}</h2>
          <div class="panel"><p class="notice">ℹ️ ${t('online.home.off')}</p><button type="button" class="btn ghost" data-nav="home">← ${t('nav.home')}</button></div>
        </div>`;
      return;
    }
    const join = S.tab === 'join';
    root.innerHTML = `
      <div class="wrap online-wrap">
        <h2 id="onlineTitle">🌐 ${t('online.title')}</h2>
        <p class="sub">${t('online.sub')}</p>
        ${S.notice ? `<div class="panel notice" role="status">${t(S.notice)}</div>` : ''}
        <div class="seg online-tabs" role="group" aria-label="${t('online.title')}">
          <button type="button" class="${join ? '' : 'on'}" data-tab="create" aria-pressed="${!join}">✨ ${t('online.tab.create')}</button>
          <button type="button" class="${join ? 'on' : ''}" data-tab="join" aria-pressed="${join}">🚪 ${t('online.tab.join')}</button>
        </div>
        <form class="panel" id="onlineForm" novalidate>
          <div class="field">
            <label for="onlineNick">${t('online.nickname')}</label>
            <input id="onlineNick" type="text" autocomplete="nickname" maxlength="${Core.NICKNAME_MAX_LENGTH}" spellcheck="false"
              enterkeyhint="go" value="${esc(S.nickname)}" aria-describedby="onlineNickHint">
            <small id="onlineNickHint">${t('online.nickname.hint')}</small>
          </div>
          ${join ? `
          <div class="field">
            <label for="onlineCode">${t('online.code')}</label>
            <input id="onlineCode" class="code-input" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false"
              enterkeyhint="go" value="${esc(S.code)}" placeholder="ABC234" aria-describedby="onlineCodeHint">
            <small id="onlineCodeHint">${t('online.code.hint')}</small>
          </div>` : `
          <h3>${t('setup.mode')}</h3>
          <div class="grid g2" role="group" aria-label="${t('setup.mode')}">${App.modes.map(([id, ico]) => modeCard(id, ico, S.variant === id, true)).join('')}</div>`}
          <div class="online-err" id="onlineErr" role="alert"></div>
          <div class="online-actions" style="margin-top:14px">
            <button type="submit" class="btn big hot" id="onlineSubmit"></button>
            <button type="button" class="btn ghost" data-nav="home">← ${t('nav.home')}</button>
          </div>
        </form>
      </div>`;

    root.onclick = (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.dataset.tab && b.dataset.tab !== S.tab) {
        sound().click();
        S.tab = b.dataset.tab;
        S.error = null;
        S.retry = null;
        renderOnline();
        $(`#screen-online [data-tab="${S.tab}"]`).focus();
      } else if (b.dataset.mode) {
        sound().click();
        S.variant = b.dataset.mode;
        root.querySelectorAll('[data-mode]').forEach((m) => {
          const on = m.dataset.mode === S.variant;
          m.classList.toggle('on', on);
          m.setAttribute('aria-pressed', String(on));
        });
      } else if (b.dataset.act === 'retry' && S.retry) {
        S.retry();
      } else if (b.dataset.act === 'rejoin') {
        rejoin(b.dataset.room);
      }
    };
    $('#onlineForm').onsubmit = (ev) => {
      ev.preventDefault();
      submit();
    };
    $('#onlineNick').oninput = (ev) => { S.nickname = ev.target.value; };
    const code = $('#onlineCode');
    if (code) {
      code.oninput = () => {
        const clean = Core.cleanCodeInput(code.value);
        if (clean !== code.value) code.value = clean;
        S.code = clean;
      };
    }
    paintForm();
    // First online visit: load supabase-js and sign in anonymously now, so Create / Join answer quickly. A failure
    // here is silent; the button shows it when the player submits.
    Client.ensureSession().catch(() => {});
    if (S.focusJoin) {
      S.focusJoin = false;
      // From a share link with a saved nickname, joining is one tap.
      (S.nickname.trim() ? $('#onlineSubmit') : $('#onlineNick')).focus({ preventScroll: true });
    }
  }

  function paintForm() {
    const err = $('#onlineErr');
    if (err) err.innerHTML = errorHtml(S.error, !!S.retry);
    const btn = $('#onlineSubmit');
    if (!btn) return;
    btn.disabled = S.busy;
    btn.setAttribute('aria-busy', String(S.busy));
    btn.textContent = S.busy ? '⏳ ' + t('online.connecting') : S.tab === 'join' ? '🚪 ' + t('online.join') : '✨ ' + t('online.create');
  }

  function formError(code, field) {
    S.error = { code };
    S.retry = null;
    paintForm();
    const input = $(field);
    if (input) input.focus();
  }

  function submit() {
    if (S.busy) return;
    const nickname = Core.cleanNickname(S.nickname || '');
    if (!nickname) return formError('INVALID_NICKNAME', '#onlineNick');
    let code = null;
    if (S.tab === 'join') {
      code = Core.normalizeCode(S.code);
      if (!code) return formError('INVALID_CODE', '#onlineCode');
    }
    sound().click();
    saveNickname(nickname);
    S.nickname = nickname;
    S.notice = null;
    const variant = S.variant;
    return run(async () => {
      const result = code
        ? await Client.rooms('join', { code, nickname })
        : await Client.rooms('create', { nickname, variant });
      setActiveRoom(result.roomId);
      if (code) S.code = '';
      return 'lobby';
    }, submit);
  }

  /* ---------- #lobby ---------- */
  function renderLobby() {
    const roomId = activeRoomId();
    if (!roomId || !Client.configured()) {
      App.go('online');
      return;
    }
    if (S.roomId !== roomId || (!S.sub && S.conn === 'idle')) connect(roomId);
    paintLobby();
  }

  function disconnect() {
    S.token++;
    if (S.sub) S.sub.unsubscribe();
    S.sub = null;
    clearTimeout(S.refreshTimer);
    S.refreshTimer = null;
    S.conn = 'idle';
  }

  async function connect(roomId) {
    disconnect();
    const token = ++S.token;
    Object.assign(S, { roomId, room: null, players: null, presence: {}, conn: 'connecting', error: null, retry: null, handedOff: false });
    try {
      const session = await Client.ensureSession();
      if (token !== S.token) return;
      S.me = session.user.id;
      const snap = await Client.fetchRoom(roomId);
      if (token !== S.token || !applySnapshot(snap)) return;
      const sub = await Client.subscribeRoom(roomId, S.me, {
        onChange: () => { if (token === S.token) refresh(); },
        onPresence: (state) => {
          if (token !== S.token) return;
          // A new or departed connection usually means a join or a leave: re-read now rather than wait for the
          // Postgres change to arrive.
          const before = Object.keys(S.presence).sort().join();
          S.presence = state;
          if (Object.keys(state).sort().join() !== before) refresh();
          paintLive();
        },
        onStatus: (status) => {
          if (token !== S.token) return;
          S.conn = status;
          paintLive();
        },
      });
      if (token !== S.token) {
        sub.unsubscribe();
        return;
      }
      S.sub = sub;
    } catch (e) {
      if (token !== S.token) return;
      S.conn = 'error';
      S.error = Client.toError(e);
      S.retry = () => connect(roomId);
      paintLive();
    }
  }

  // Coalesces bursts of Realtime changes into one read; an older read that answers late is ignored.
  function refresh() {
    if (S.refreshTimer) return;
    S.refreshTimer = setTimeout(async () => {
      S.refreshTimer = null;
      const token = S.token;
      const seq = ++S.fetchSeq;
      try {
        const snap = await Client.fetchRoom(S.roomId);
        if (token === S.token && seq === S.fetchSeq) applySnapshot(snap);
      } catch (e) { /* the next change or the channel's reconnect reads the room again */ }
    }, REFRESH_DELAY_MS);
  }

  // → false when the room is gone or the player is not seated in it any more.
  function applySnapshot(snap) {
    const seated = snap && Core.isActiveStatus(snap.room.status) && snap.players.some((p) => p.user_id === S.me);
    if (!seated) {
      roomGone();
      return false;
    }
    const before = S.room;
    const beforePlayers = S.players;
    S.room = snap.room;
    S.players = snap.players;
    if (before && beforePlayers) announce(before, beforePlayers);
    paintLive();
    return true;
  }

  function announce(before, beforePlayers) {
    const { joined, left } = Core.diffPlayers(beforePlayers, S.players);
    const lines = joined.map((name) => t('online.sr.joined', { name })).concat(left.map((name) => t('online.sr.left', { name })));
    if (before.host_id !== S.room.host_id) {
      const host = S.players.find((p) => p.user_id === S.room.host_id);
      if (host) lines.push(t('online.sr.host', { name: host.nickname }));
    }
    if (before.variant !== S.room.variant) lines.push(t('online.sr.mode', { mode: t('mode.' + S.room.variant + '.t') }));
    if (lines.length) sr(lines.join('. '));
  }

  function roomGone() {
    const roomId = S.roomId;
    disconnect();
    clearActiveRoom(roomId);
    Object.assign(S, { roomId: null, room: null, players: null, notice: 'online.lobby.closed' });
    if (App.screen === 'lobby') App.go('online');
  }

  function paintLobby() {
    const root = $('#screen-lobby');
    if (S.room && S.room.status === 'playing') {
      paintStarting(root);
      return;
    }
    const canShare = typeof global.navigator.share === 'function';
    root.innerHTML = `
      <div class="wrap">
        <h2 id="lobbyTitle">🌐 ${t('online.lobby.title')}</h2>
        <div class="lobby-conn" id="lobbyConn" role="status"></div>
        <div class="lobby-top">
          <div class="panel">
            <div class="kicker">${t('online.code')}</div>
            <div class="room-code" id="lobbyCode"></div>
            <div class="lobby-share">
              <button type="button" class="btn small" data-act="copyCode">📋 ${t('online.lobby.copyCode')}</button>
              <button type="button" class="btn small" data-act="copyLink">🔗 ${t('online.lobby.copyLink')}</button>
              ${canShare ? `<button type="button" class="btn small" data-act="share">📤 ${t('online.lobby.share')}</button>` : ''}
            </div>
            <p class="muted small">${t('online.lobby.invite')}</p>
          </div>
          <div class="panel">
            <h3 id="lobbyPlayers"></h3>
            <ul class="lobby-seats" id="lobbySeats" aria-labelledby="lobbyPlayers"></ul>
          </div>
        </div>
        <div class="panel lobby-mode">
          <h3>${t('setup.mode')}</h3>
          <div id="lobbyMode"></div>
        </div>
        <div class="panel summary lobby-bar">
          <div class="s" id="lobbyStatus"></div>
          <div class="online-actions">
            <button type="button" class="btn ghost" data-act="leave">🚪 ${t('online.lobby.leave')}</button>
            <button type="button" class="btn big hot" data-act="start" id="lobbyStart" hidden>▶ ${t('online.lobby.start')}</button>
          </div>
        </div>
        <div class="online-err" id="lobbyErr" role="alert" style="margin-top:12px"></div>
      </div>`;
    root.onclick = onLobbyClick;
    S.modeKey = null;
    paintLive();
  }

  // MIND-06 replaces this placeholder: window.MindOnlineTable.enter({ roomId, room, players, userId }) is called once.
  function paintStarting(root) {
    root.innerHTML = `
      <div class="wrap">
        <div class="panel starting" role="status">
          <div class="spin" aria-hidden="true">🃏</div>
          <h2 id="lobbyTitle">${t('online.lobby.starting')}</h2>
          <p class="muted">${t('online.lobby.startingSub')}</p>
          <div class="online-err" id="lobbyErr" role="alert"></div>
          <div class="online-actions" style="justify-content:center">
            <button type="button" class="btn ghost" data-act="leave">🚪 ${t('online.lobby.leave')}</button>
          </div>
        </div>
      </div>`;
    root.onclick = onLobbyClick;
    paintError();
    const table = global.MindOnlineTable;
    if (!S.handedOff && table && typeof table.enter === 'function') {
      S.handedOff = true;
      table.enter({ roomId: S.roomId, room: S.room, players: S.players, userId: S.me });
    }
  }

  function paintError() {
    const box = $('#lobbyErr');
    if (box) box.innerHTML = errorHtml(S.error, !!S.retry);
  }

  // Updates the lobby in place, so keyboard focus stays where it is while players come and go.
  function paintLive() {
    if (App.screen !== 'lobby') return;
    const root = $('#screen-lobby');
    const playing = !!S.room && S.room.status === 'playing';
    if (playing !== !!root.querySelector('.starting')) {
      paintLobby();
      return;
    }
    if (playing) {
      paintError();
      return;
    }
    $('#lobbyConn').textContent = S.conn === 'down' ? '📡 ' + t('online.lobby.reconnecting') : '';
    $('#lobbyCode').textContent = S.room ? S.room.code : '······';
    const isHost = !!S.room && S.room.host_id === S.me;
    const seats = paintSeats();
    paintMode(isHost);
    const state = Core.startState(seats, isHost);
    $('#lobbyStatus').textContent = S.room ? t('online.lobby.' + state.reason) : '⏳ ' + t('online.connecting');
    const start = $('#lobbyStart');
    start.hidden = !isHost;
    start.disabled = !state.canStart || S.busy;
    paintError();
  }

  function node(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function paintSeats() {
    const seats = Core.mergeSeats(S.players || [], S.presence, { hostId: S.room && S.room.host_id, meId: S.me });
    $('#lobbyPlayers').textContent = t('online.lobby.players', { n: seats.filter((s) => !s.empty).length });
    const list = $('#lobbySeats');
    list.textContent = '';
    for (const s of seats) {
      const li = node('li', 'lobby-seat' + (s.empty ? ' empty' : '') + (s.you ? ' you' : ''));
      if (s.empty) {
        li.append(node('span', 'dot'), node('span', null, t('online.lobby.free')));
      } else {
        li.append(node('span', 'nick', s.nickname));
        if (s.host) {
          const crown = node('span', 'crown', '👑');
          crown.setAttribute('role', 'img');
          crown.setAttribute('aria-label', t('online.lobby.host'));
          crown.title = t('online.lobby.host');
          li.append(crown);
        }
        if (s.you) li.append(node('span', 'tag', t('online.lobby.you')));
        const presence = node('span', 'presence' + (s.online ? ' on' : ''));
        presence.append(node('span', 'dot' + (s.online ? ' on' : '')), document.createTextNode(t(s.online ? 'online.lobby.online' : 'online.lobby.away')));
        li.append(presence);
      }
      list.append(li);
    }
    return seats;
  }

  function paintMode(isHost) {
    const variant = S.room ? S.room.variant : '';
    const key = [isHost, variant, I18N.lang].join(':');
    if (key === S.modeKey) return;
    S.modeKey = key;
    const box = $('#lobbyMode');
    const active = global.document.activeElement;
    const focused = active && box.contains(active) ? active.dataset.mode : null;
    if (!variant) {
      box.innerHTML = '';
    } else if (isHost) {
      box.innerHTML = `<div class="grid g2" role="group" aria-label="${t('setup.mode')}">${App.modes.map(([id, ico]) => modeCard(id, ico, id === variant, true)).join('')}</div>`;
    } else {
      const [id, ico] = App.modes.find(([m]) => m === variant) || [variant, '🧠'];
      box.innerHTML = modeCard(id, ico, true, false) + `<p class="muted small">${t('online.lobby.hostOnly')}</p>`;
    }
    const again = focused && box.querySelector(`[data-mode="${focused}"]`);
    if (again) again.focus({ preventScroll: true });
  }

  function onLobbyClick(ev) {
    const b = ev.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.mode) setMode(b.dataset.mode);
    else if (b.dataset.act === 'copyCode') copy(S.room && S.room.code, b);
    else if (b.dataset.act === 'copyLink') copy(S.room && shareLink(), b);
    else if (b.dataset.act === 'share') share(b);
    else if (b.dataset.act === 'start') start();
    else if (b.dataset.act === 'leave') leave();
    else if (b.dataset.act === 'retry' && S.retry) S.retry();
  }

  const shareLink = () => Core.shareUrl(global.location.href, S.room.code);

  async function copy(text, button) {
    if (!text) return;
    sound().click();
    let ok = false;
    try {
      await global.navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      const area = node('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(area);
      area.select();
      try {
        ok = document.execCommand('copy');
      } catch (e2) {
        ok = false;
      }
      area.remove();
      if (button) button.focus({ preventScroll: true });
    }
    const msg = t(ok ? 'online.lobby.copied' : 'online.lobby.copyFailed');
    App.toast(esc(msg));
    sr(msg);
  }

  async function share(button) {
    if (!S.room) return;
    try {
      await global.navigator.share({ title: 'The Mind', text: t('online.lobby.shareText', { code: S.room.code }), url: shareLink() });
    } catch (e) {
      if (!e || e.name !== 'AbortError') copy(shareLink(), button);
    }
  }

  function setMode(variant) {
    if (S.busy || !S.room || S.room.variant === variant || S.room.host_id !== S.me) return;
    sound().click();
    const roomId = S.roomId;
    run(async () => {
      await Client.rooms('setVariant', { roomId, variant });
      if (S.roomId === roomId && S.room) S.room = Object.assign({}, S.room, { variant });
      refresh();
    }, () => setMode(variant));
  }

  function start() {
    if (S.busy || !S.room) return;
    sound().click();
    const roomId = S.roomId;
    run(async () => {
      const result = await Client.roomAction(roomId, 'start');
      if (S.roomId === roomId && S.room && result.status) S.room = Object.assign({}, S.room, { status: result.status });
    }, start);
  }

  function leave() {
    if (S.busy) return;
    if (S.room && S.room.status === 'playing' && !global.confirm(t('online.lobby.confirmLeaveGame'))) return;
    sound().click();
    const roomId = S.roomId;
    run(async () => {
      try {
        await Client.rooms('leave', { roomId });
      } catch (e) {
        if (!e || e.code !== 'ROOM_NOT_FOUND') throw e;
      }
      disconnect();
      clearActiveRoom(roomId);
      Object.assign(S, { roomId: null, room: null, players: null, notice: null });
      return 'online';
    }, leave);
  }

  App.registerScreen('online', { render: renderOnline, leave: clearError });
  App.registerScreen('lobby', {
    render: renderLobby,
    leave() {
      disconnect();
      clearError();
    },
  });

  global.MindOnlineLobby = { boot, homeBanner, homeButton, homeNote, bindHome };
})(window);
