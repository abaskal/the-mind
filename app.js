(function () {
  'use strict';
  const M = window.TheMind;
  const BOT_NAMES = ['Ada', 'Kai', 'Mira'];
  const HUMAN = 0;

  const $ = (id) => document.getElementById(id);
  let state = null;
  let msPerPoint = 180;
  let botTimers = [];
  let paused = true;
  let pileOwners = [];
  let lastReveal = {};

  const nameOf = (p) => (p === HUMAN ? 'You' : BOT_NAMES[p - 1]);

  function clearBotTimers() {
    botTimers.forEach(clearTimeout);
    botTimers = [];
  }

  // Each bot "counts" silently: it waits roughly proportional to the gap
  // between its lowest card and the current top of the pile, with some jitter
  // so bots aren't perfectly predictable.
  function scheduleBots() {
    clearBotTimers();
    if (paused || state.status !== 'playing') return;
    const top = M.topCard(state);
    for (let p = 1; p < state.numPlayers; p++) {
      const card = M.lowestCard(state, p);
      if (card == null) continue;
      const gap = card - top;
      const jitter = 0.85 + Math.random() * 0.3;
      const delay = (500 + gap * msPerPoint) * jitter;
      botTimers.push(setTimeout(() => act(p, card), delay));
    }
  }

  function act(player, card) {
    if (paused || state.status !== 'playing') return;
    if (M.lowestCard(state, player) !== card) return;
    const result = M.playCard(state, player, card);
    pileOwners.push(player);
    lastReveal = {};
    afterAction(result);
  }

  function afterAction(result) {
    render(result);
    if (result && result.missed.length && state.status !== 'playing') {
      handleStatus();
      const list = result.missed.map((m) => `${nameOf(m.player)}: ${m.card}`).join(', ');
      $('message').textContent = `Oops! (${list}) -1 life. ` + $('message').textContent;
      return;
    }
    if (result && result.missed.length) {
      const list = result.missed.map((m) => `${nameOf(m.player)}: ${m.card}`).join(', ');
      setMessage(`Oops! Lower cards were still out (${list}). -1 life.`, 'bad');
      $('pile').classList.add('bad');
    } else if (result) {
      setMessage('');
    }
    handleStatus();
    // Brief pause after a mistake so everyone can "re-focus".
    if (result && result.missed.length && state.status === 'playing') {
      paused = true;
      setTimeout(() => { paused = false; scheduleBots(); }, 1500);
    } else {
      scheduleBots();
    }
  }

  function handleStatus() {
    const s = state.status;
    $('playBtn').classList.toggle('hidden', s !== 'playing');
    $('starBtn').classList.toggle('hidden', s !== 'playing');
    $('nextBtn').classList.toggle('hidden', s !== 'levelComplete');
    $('againBtn').classList.toggle('hidden', s !== 'won' && s !== 'lost');
    if (s === 'levelComplete') {
      clearBotTimers();
      const reward = state.lastReward ? ` Reward: +1 ${state.lastReward === 'life' ? '❤️ life' : '⭐ star'}.` : '';
      setMessage(`Level ${state.level} complete!${reward}`, 'good');
    } else if (s === 'won') {
      clearBotTimers();
      setMessage(`🎉 You beat all ${state.maxLevel} levels! You are one mind.`, 'good');
    } else if (s === 'lost') {
      clearBotTimers();
      setMessage(`💀 Out of lives on level ${state.level}. Try again!`, 'bad');
    }
  }

  function humanPlay() {
    if (paused || state.status !== 'playing') return;
    const card = M.lowestCard(state, HUMAN);
    if (card == null) return;
    const result = M.playCard(state, HUMAN, card);
    pileOwners.push(HUMAN);
    lastReveal = {};
    afterAction(result);
  }

  function proposeStar() {
    if (paused || state.status !== 'playing' || state.stars <= 0) return;
    paused = true;
    clearBotTimers();
    setMessage('✋ You propose a throwing star… bots are thinking.');
    setTimeout(() => {
      const revealed = M.useStar(state);
      lastReveal = {};
      revealed.forEach((r) => { lastReveal[r.player] = r.card; });
      const list = revealed.map((r) => `${nameOf(r.player)}: ${r.card}`).join(', ');
      setMessage(`⭐ Everyone agreed. Discarded: ${list}`, 'good');
      render();
      handleStatus();
      setTimeout(() => { paused = false; scheduleBots(); }, 1200);
    }, 900);
  }

  function startLevel() {
    M.dealLevel(state);
    beginCountdown();
  }

  function beginCountdown() {
    pileOwners = [];
    lastReveal = {};
    paused = true;
    clearBotTimers();
    render();
    handleStatus();
    let n = 3;
    const tick = () => {
      if (n > 0) {
        setMessage(`Level ${state.level} — concentrate… ${n}`);
        n--;
        setTimeout(tick, 700);
      } else {
        setMessage('Go.');
        paused = false;
        render();
        scheduleBots();
      }
    };
    tick();
  }

  function setMessage(text, kind) {
    const el = $('message');
    el.textContent = text;
    el.className = 'message' + (kind ? ' ' + kind : '');
  }

  function render(result) {
    $('level').textContent = state.level;
    $('maxLevel').textContent = state.maxLevel;
    $('lives').textContent = '❤️'.repeat(Math.max(0, state.lives)) || '—';
    $('stars').textContent = '⭐'.repeat(state.stars) || 'no stars';

    const bots = $('bots');
    bots.innerHTML = '';
    for (let p = 1; p < state.numPlayers; p++) {
      const div = document.createElement('div');
      div.className = 'bot' + (result && result.player === p ? ' just-played' : '');
      const backs = state.status === 'playing' || state.status === 'idle'
        ? state.hands[p].map(() => '<div class="back"></div>').join('')
        : state.hands[p].map((c) => `<span class="history"><span>${c}</span></span>`).join('');
      const reveal = lastReveal[p] != null ? `⭐ discarded ${lastReveal[p]}` : '';
      div.innerHTML = `<div class="name">🤖 ${BOT_NAMES[p - 1]}</div>
        <div class="backs">${backs}</div>
        <div class="reveal">${reveal}</div>`;
      bots.appendChild(div);
    }

    const pile = $('pile');
    const top = M.topCard(state);
    pile.className = 'card big' + (top ? '' : ' empty');
    pile.textContent = top || '–';
    if (result) { void pile.offsetWidth; pile.classList.add('flash'); }
    $('pileOwner').textContent = pileOwners.length ? `played by ${nameOf(pileOwners[pileOwners.length - 1])}` : '';

    $('history').innerHTML = state.pile.map((c) => `<span>${c}</span>`).join('');
    $('discarded').innerHTML = state.discarded.map((c) => `<span>${c}</span>`).join('');

    const hand = $('hand');
    hand.innerHTML = '';
    state.hands[HUMAN].forEach((c, i) => {
      const el = document.createElement('div');
      el.className = 'card' + (i === 0 ? ' lowest' : '');
      el.textContent = c;
      if (i === 0) el.addEventListener('click', humanPlay);
      hand.appendChild(el);
    });

    const canAct = !paused && state.status === 'playing';
    $('playBtn').disabled = !canAct || !state.hands[HUMAN].length;
    $('starBtn').disabled = !canAct || state.stars <= 0;
  }

  function newGame() {
    const players = Number($('players').value);
    msPerPoint = Number($('pace').value);
    state = M.createGame(players);
    $('setup').classList.add('hidden');
    $('table').classList.remove('hidden');
    startLevel();
  }

  function quit() {
    paused = true;
    clearBotTimers();
    $('table').classList.add('hidden');
    $('setup').classList.remove('hidden');
  }

  $('start').addEventListener('click', newGame);
  $('playBtn').addEventListener('click', humanPlay);
  $('starBtn').addEventListener('click', proposeStar);
  $('nextBtn').addEventListener('click', () => { M.nextLevel(state); beginCountdown(); });
  $('againBtn').addEventListener('click', quit);
  $('quit').addEventListener('click', quit);
  document.addEventListener('keydown', (e) => {
    if (!state || $('table').classList.contains('hidden')) return;
    if (e.code === 'Space') { e.preventDefault(); humanPlay(); }
    if (e.key === 's' || e.key === 'S') proposeStar();
    if (e.key === 'Enter' && state.status === 'levelComplete') { M.nextLevel(state); beginCountdown(); }
  });
})();
