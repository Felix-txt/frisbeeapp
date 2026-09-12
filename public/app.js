'use strict';

/* ================================================================== */
/* Helpers                                                             */
/* ================================================================== */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

let toastTimer;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
}

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong (' + res.status + ')');
  return data;
}

const parText = (n) => (n === 0 ? 'E' : n > 0 ? '+' + n : String(n));

function labelFor(strokes, par) {
  if (strokes === 1) return 'Ace';
  const diff = strokes - par;
  if (diff <= -3) return 'Albatross';
  if (diff === -2) return 'Eagle';
  if (diff === -1) return 'Birdie';
  if (diff === 0) return 'Par';
  if (diff === 1) return 'Bogey';
  if (diff === 2) return 'Double';
  return '+' + diff;
}

function tagClass(strokes, par) {
  if (strokes === 1 || strokes - par <= -2) return 'tag eagle';
  if (strokes - par === -1) return 'tag birdie';
  if (strokes - par === 0) return 'tag par';
  if (strokes - par === 1) return 'tag bogey';
  return 'tag bad';
}

function cellClass(strokes, par) {
  if (strokes === 1 || strokes - par <= -2) return 'cell-eagle';
  if (strokes - par === -1) return 'cell-birdie';
  if (strokes - par === 1) return 'cell-bogey';
  if (strokes - par >= 2) return 'cell-bad';
  return '';
}

/* ================================================================== */
/* Identity + state                                                    */
/* ================================================================== */

const DEVICE_KEY = 'discgolf.deviceId';
const ACTIVE_KEY = 'discgolf.activeRound';
const NAME_KEY = 'discgolf.myName';

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
         Date.now().toString(36) + Math.random().toString(36).slice(2);
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

const deviceId = getDeviceId();

const state = {
  round: null,
  results: null,
  presence: [],
  hole: 1,
  view: 'home',
  pendingJoin: null, // round found by code, waiting for a seat choice
};

/** The player this phone controls, if any. */
function me() {
  if (!state.round) return null;
  return state.round.players.find((p) => p.deviceId === deviceId) || null;
}

function isOnline(playerId) {
  return state.presence.some((p) => p.playerId === playerId);
}

function showView(name) {
  state.view = name;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  const tabFor = { home: 'home', join: 'home', create: 'home', lobby: 'home', play: 'home', result: 'home', history: 'history', stats: 'stats' }[name];
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === tabFor));
  window.scrollTo({ top: 0 });
}

/* ================================================================== */
/* Live sync                                                           */
/*                                                                     */
/* EventSource gives us server push plus automatic reconnection, which  */
/* matters on a phone that keeps dropping in and out of signal on a     */
/* course. Every mutation anyone makes is broadcast to all devices.     */
/* ================================================================== */

let source = null;
let sourceRoundId = null;

function setConnected(on) {
  const node = $('#conn');
  node.hidden = !state.round;
  node.classList.toggle('off', !on);
  $('#conn-text').textContent = on ? 'Live' : 'Reconnecting…';
}

function connectLive(roundId) {
  if (sourceRoundId === roundId && source && source.readyState !== 2) return;
  disconnectLive();

  const mine = me();
  const qs = new URLSearchParams({ deviceId, playerId: mine ? mine.id : '' });
  source = new EventSource('/api/rounds/' + roundId + '/events?' + qs);
  sourceRoundId = roundId;

  source.addEventListener('open', () => setConnected(true));

  source.addEventListener('round', (e) => {
    const payload = JSON.parse(e.data);
    setConnected(true);
    applyRemote(payload);
  });

  source.addEventListener('presence', (e) => {
    state.presence = JSON.parse(e.data).presence || [];
    if (state.view === 'play') { renderScoreRows(); renderLiveStandings(); }
    if (state.view === 'lobby') renderLobby();
  });

  source.addEventListener('deleted', () => {
    toast('The host deleted this round');
    clearActiveRound();
    showView('home');
  });

  source.addEventListener('error', () => setConnected(false));
}

function disconnectLive() {
  if (source) source.close();
  source = null;
  sourceRoundId = null;
}

/**
 * Applies a server snapshot without throwing away edits this phone has made
 * but not yet confirmed — otherwise a broadcast triggered by a friend could
 * visibly revert a stroke you just typed.
 */
function applyRemote(payload) {
  const wasFinished = state.round && state.round.status === 'finished';
  state.round = payload.round;
  state.results = payload.results;
  if (payload.presence) state.presence = payload.presence;

  for (const { hole, playerId, value } of pending.values()) {
    if (state.round.scores[playerId]) state.round.scores[playerId][hole - 1] = value;
  }

  if (state.view === 'play') {
    if (state.round.status === 'finished') { renderResult(); showView('result'); return; }
    renderPlay();
  } else if (state.view === 'lobby') {
    renderLobby();
  } else if (state.view === 'result') {
    if (state.round.status === 'active' && wasFinished) { renderPlay(); showView('play'); return; }
    renderResult();
  }
}

/* ================================================================== */
/* Round lifecycle                                                     */
/* ================================================================== */

function setRound(data) {
  state.round = data.round;
  state.results = data.results;
  state.presence = data.presence || [];
}

function rememberActiveRound(id) {
  localStorage.setItem(ACTIVE_KEY, id);
}

function clearActiveRound() {
  localStorage.removeItem(ACTIVE_KEY);
  disconnectLive();
  state.round = null;
  state.results = null;
  setConnected(false);
  $('#conn').hidden = true;
}

function enterRound(data, { toLobby = false } = {}) {
  setRound(data);
  rememberActiveRound(data.round.id);
  connectLive(data.round.id);

  if (data.round.status === 'finished') {
    renderResult();
    showView('result');
    return;
  }
  if (toLobby) {
    renderLobby();
    showView('lobby');
    return;
  }
  state.hole = firstUnplayedHole(data.round);
  renderPlay();
  showView('play');
}

function firstUnplayedHole(round) {
  const mine = round.players.find((p) => p.deviceId === deviceId);
  for (let i = 0; i < round.holes; i++) {
    const done = mine
      ? typeof round.scores[mine.id][i] === 'number'
      : round.players.every((p) => typeof round.scores[p.id][i] === 'number');
    if (!done) return i + 1;
  }
  return round.holes;
}

/* ================================================================== */
/* Create round                                                        */
/* ================================================================== */

function addPlayerRow(value = '', focus = true) {
  const row = el('div', 'player-row');
  const input = el('input');
  input.type = 'text';
  input.placeholder = 'Friend\u2019s name';
  input.value = value;
  input.maxLength = 24;
  input.autocomplete = 'off';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addPlayerRow(); }
  });

  const remove = el('button', 'btn ghost', '\u2715');
  remove.type = 'button';
  remove.addEventListener('click', () => row.remove());

  row.append(input, remove);
  $('#player-list').append(row);
  if (focus) input.focus();
  return input;
}

function buildParGrid() {
  const holes = Number($('#holes').value) || 0;
  const grid = $('#par-grid');
  const previous = $$('#par-grid input').map((i) => i.value);
  grid.innerHTML = '';
  for (let i = 0; i < holes; i++) {
    const cell = el('label', 'par-cell');
    cell.append(el('span', null, 'Hole ' + (i + 1)));
    const input = el('input');
    input.type = 'number';
    input.min = '2';
    input.max = '8';
    input.value = previous[i] || '3';
    cell.append(input);
    grid.append(cell);
  }
}

async function createRound() {
  $('#setup-error').textContent = '';
  const hostName = $('#host-name').value.trim();
  if (!hostName) {
    $('#setup-error').textContent = 'Enter your name first';
    return;
  }
  localStorage.setItem(NAME_KEY, hostName);

  const friends = $$('#player-list input').map((i) => i.value.trim()).filter(Boolean);
  const pars = $$('#par-grid input').map((i) => Number(i.value) || 3);

  try {
    const data = await api('/rounds', {
      method: 'POST',
      body: {
        course: $('#course').value.trim(),
        holes: Number($('#holes').value),
        players: [hostName, ...friends],
        pars,
        deviceId,
      },
    });
    enterRound(data, { toLobby: true });
  } catch (err) {
    $('#setup-error').textContent = err.message;
  }
}

/* ================================================================== */
/* Join flow                                                           */
/* ================================================================== */

async function findRound() {
  const code = $('#join-code').value.trim().toUpperCase();
  $('#join-error').textContent = '';
  if (code.length < 4) {
    $('#join-error').textContent = 'The code is 4 characters';
    return;
  }
  try {
    const data = await api('/rounds/code/' + encodeURIComponent(code));
    state.pendingJoin = data;
    renderSeatPicker(data);
  } catch (err) {
    $('#seat-picker').hidden = true;
    $('#join-error').textContent = err.message;
  }
}

function renderSeatPicker(data) {
  const { round } = data;
  $('#seat-picker').hidden = false;
  $('#seat-course').textContent = round.course + ' · ' + round.holes + ' holes';

  const list = $('#seat-list');
  list.innerHTML = '';

  round.players.forEach((p) => {
    const taken = p.deviceId && p.deviceId !== deviceId;
    const isMine = p.deviceId === deviceId;
    const seat = el('button', 'seat' + (taken ? ' taken' : '') + (isMine ? ' you' : ''));
    seat.type = 'button';
    seat.append(el('span', 'sname', p.name));
    seat.append(el('span', 'status', isMine ? 'You' : taken ? 'Taken' : 'Tap to pick'));
    if (!taken) {
      seat.addEventListener('click', () => claimSeat(round.id, p.id));
    } else {
      seat.disabled = true;
    }
    list.append(seat);
  });

  const saved = localStorage.getItem(NAME_KEY);
  if (saved && !$('#join-name').value) $('#join-name').value = saved;
}

async function claimSeat(roundId, playerId) {
  try {
    const data = await api('/rounds/' + roundId + '/join', {
      method: 'POST',
      body: { deviceId, playerId },
    });
    const seat = data.round.players.find((p) => p.id === playerId);
    if (seat) localStorage.setItem(NAME_KEY, seat.name);
    enterRound(data, { toLobby: data.round.status === 'active' });
    toast('Joined as ' + (seat ? seat.name : 'player'));
  } catch (err) {
    $('#join-error').textContent = err.message;
  }
}

async function joinAsNew() {
  const name = $('#join-name').value.trim();
  if (!name) {
    $('#join-error').textContent = 'Enter your name';
    return;
  }
  if (!state.pendingJoin) return;
  try {
    const data = await api('/rounds/' + state.pendingJoin.round.id + '/join', {
      method: 'POST',
      body: { deviceId, name },
    });
    localStorage.setItem(NAME_KEY, name);
    enterRound(data, { toLobby: true });
    toast('Joined as ' + name);
  } catch (err) {
    $('#join-error').textContent = err.message;
  }
}

/* ================================================================== */
/* Lobby                                                               */
/* ================================================================== */

function shareUrl() {
  if (!state.round) return location.origin;
  return location.origin + '/?code=' + state.round.code;
}

function renderLobby() {
  const { round } = state;
  $('#lobby-code').textContent = round.code;
  $('#lobby-course').textContent = round.course + ' · ' + round.holes + ' holes · par ' + state.results.coursePar;
  $('#lobby-url').textContent = shareUrl();

  const online = state.presence.length;
  $('#lobby-count').textContent = round.players.length + (online ? ' · ' + online + ' online' : '');

  const list = $('#lobby-players');
  list.innerHTML = '';
  round.players.forEach((p) => {
    const row = el('div', 'seat' + (p.deviceId === deviceId ? ' you' : ''));
    row.append(el('span', isOnline(p.id) ? 'dot-on' : 'dot-off'));
    row.append(el('span', 'sname', p.name));
    row.append(el('span', 'status',
      p.deviceId === deviceId ? 'You' : p.deviceId ? (isOnline(p.id) ? 'Ready' : 'Joined') : 'Waiting…'));
    list.append(row);
  });
}

async function shareRound() {
  const url = shareUrl();
  const text = `Join my disc golf round — code ${state.round.code}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Disc Golf', text, url });
      return;
    } catch { /* user cancelled — fall through to copy */ }
  }
  copyLink();
}

async function copyLink() {
  const url = shareUrl();
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch {
    // clipboard API needs https or localhost; fall back to a selectable prompt
    window.prompt('Copy this link:', url);
  }
}

/* ================================================================== */
/* Play view                                                           */
/* ================================================================== */

function renderPlay() {
  const round = state.round;
  if (!round) return;

  $('#play-course').textContent = round.course;
  const mine = me();
  $('#play-sub').textContent =
    'Code ' + round.code + ' · ' + round.players.length + ' players' +
    (mine ? '' : ' · watching');

  $('#hole-number').textContent = state.hole;
  $('#hole-par').textContent = round.pars[state.hole - 1];
  $('#prev-hole').disabled = state.hole === 1;
  $('#next-hole').disabled = state.hole === round.holes;

  renderDots();
  renderMeCard();
  renderScoreRows();
  renderLiveStandings();
  if (!$('#scorecard-card').hidden) renderScorecard();
}

/*
 * The hole dots are rebuilt on every score change, which on a phone means a
 * tap can be swallowed: if the buttons are replaced between touchstart and
 * touchend no click event is ever produced. So they are created once per
 * round and afterwards only their classes are patched.
 */
let dotsSignature = null;
const dotNodes = [];

function renderDots() {
  const wrap = $('#hole-dots');
  const signature = state.round.id + ':' + state.round.holes;

  if (signature !== dotsSignature) {
    dotsSignature = signature;
    dotNodes.length = 0;
    wrap.innerHTML = '';
    for (let i = 1; i <= state.round.holes; i++) {
      const dot = el('button', 'dot', String(i));
      dot.type = 'button';
      dot.addEventListener('click', () => { flushScores(); state.hole = i; renderPlay(); });
      wrap.append(dot);
      dotNodes.push(dot);
    }
  }

  const mine = me();
  dotNodes.forEach((dot, index) => {
    const i = index + 1;
    const all = state.round.players.every((p) => typeof state.round.scores[p.id][i - 1] === 'number');
    const own = mine && typeof state.round.scores[mine.id][i - 1] === 'number';
    dot.classList.toggle('done', all);
    dot.classList.toggle('mine', !all && !!own);
    dot.classList.toggle('current', i === state.hole);
  });
}

function renderMeCard() {
  const mine = me();
  const card = $('#me-card');
  if (!mine) { card.hidden = true; return; }
  card.hidden = false;

  const par = state.round.pars[state.hole - 1];
  const value = state.round.scores[mine.id][state.hole - 1];

  $('#me-name').textContent = mine.name;
  const valueNode = $('#me-value');
  valueNode.textContent = typeof value === 'number' ? value : 'tap';
  valueNode.classList.toggle('empty', typeof value !== 'number');

  const tag = $('#me-tag');
  if (typeof value === 'number') {
    tag.className = tagClass(value, par);
    tag.textContent = labelFor(value, par);
  } else {
    tag.className = 'tag';
    tag.textContent = 'par ' + par;
  }

  // Same reasoning as the score rows: only rebuild when the options actually
  // change, otherwise a live update could swap the button out mid-tap.
  const quick = $('#quick-row');
  const wanted = [par - 1, par, par + 1, par + 2].filter((s) => s >= 1);
  if (quick.dataset.par !== String(par)) {
    quick.dataset.par = String(par);
    quick.innerHTML = '';
    wanted.forEach((strokes) => {
      const btn = el('button', 'quick');
      btn.type = 'button';
      btn.dataset.strokes = String(strokes);
      btn.append(el('b', null, String(strokes)));
      btn.append(document.createTextNode(labelFor(strokes, par)));
      btn.addEventListener('click', () => setMyScore(strokes));
      quick.append(btn);
    });
  }
  $$('#quick-row .quick').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.strokes) === value);
  });
}

function setMyScore(value) {
  const mine = me();
  if (!mine) return;
  const clamped = Math.min(30, Math.max(1, value));
  saveScore(mine.id, clamped);
  renderMeCard();
  renderDots();
  renderScoreRows();
  renderLiveStandings();
}

function bumpMyScore(delta) {
  const mine = me();
  if (!mine) return;
  const par = state.round.pars[state.hole - 1];
  const current = state.round.scores[mine.id][state.hole - 1];
  setMyScore(typeof current === 'number' ? current + delta : par);
}

/*
 * Rebuilding this list destroys the <input> elements. If a live update from a
 * friend lands between someone typing a value and the change event firing, the
 * freshly built input reads back empty and saves null — wiping the score. So
 * the DOM is only rebuilt when its *shape* changes (different hole, different
 * players, edit mode toggled); value-only updates are patched in place, and an
 * input that currently has focus is never overwritten underneath the player.
 */
let rowsSignature = null;

function renderScoreRows() {
  const editAll = $('#edit-all').checked || !me();
  // Presence deliberately excluded: a friend going online must not rebuild
  // the rows and swallow a tap on a stepper. It is patched in refresh instead.
  const signature = [
    state.hole,
    editAll,
    me() ? me().id : '',
    state.round.players.map((p) => p.id).join(','),
  ].join('|');

  if (signature === rowsSignature && rowRefs.size === state.round.players.length) {
    refreshScoreRows();
    return;
  }
  rowsSignature = signature;
  buildScoreRows(editAll);
}

/** Patches values into the existing rows without touching the DOM structure. */
function refreshScoreRows() {
  const par = state.round.pars[state.hole - 1];
  state.round.players.forEach((player) => {
    const ref = rowRefs.get(player.id);
    if (!ref) return;
    const value = state.round.scores[player.id][state.hole - 1];
    updateRowTag(player.id, value);
    ref.liveDot.classList.toggle('off', !isOnline(player.id));
    if (ref.input) {
      if (document.activeElement !== ref.input) ref.input.value = value ?? '';
    } else if (ref.readonly) {
      ref.readonly.textContent = typeof value === 'number' ? String(value) : '–';
    }
  });
}

function buildScoreRows(editAll) {
  const wrap = $('#score-inputs');
  const par = state.round.pars[state.hole - 1];
  wrap.innerHTML = '';
  rowRefs.clear();

  state.round.players.forEach((player) => {
    const value = state.round.scores[player.id][state.hole - 1];
    const isMine = me() && player.id === me().id;
    const row = el('div', 'score-row' + (isMine ? ' is-me' : ''));

    const liveDot = el('span', 'live-dot' + (isOnline(player.id) ? '' : ' off'));
    row.append(liveDot);
    row.append(el('div', 'name', player.name + (isMine ? ' (you)' : '')));

    const tag = el('span', 'tag gone', '');
    if (typeof value === 'number') {
      tag.className = tagClass(value, par);
      tag.textContent = labelFor(value, par);
    }
    row.append(tag);

    if (editAll) {
      const stepper = el('div', 'stepper');
      const minus = el('button', null, '\u2212');
      minus.type = 'button';
      const input = el('input');
      input.type = 'number';
      input.min = '1';
      input.max = '30';
      input.inputMode = 'numeric';
      input.value = value ?? '';
      input.placeholder = String(par);
      const plus = el('button', null, '+');
      plus.type = 'button';

      minus.addEventListener('click', () => {
        const next = Math.max(1, (Number(input.value) || par) - 1);
        input.value = next;
        saveScore(player.id, next);
      });
      plus.addEventListener('click', () => {
        const next = Math.min(30, (Number(input.value) || par - 1) + 1);
        input.value = next;
        saveScore(player.id, next);
      });
      input.addEventListener('change', () => {
        saveScore(player.id, input.value === '' ? null : Number(input.value));
      });

      stepper.append(minus, input, plus);
      row.append(stepper);
      rowRefs.set(player.id, { tag, input, readonly: null, liveDot });
    } else {
      const readonly = el('div', 'readonly', typeof value === 'number' ? String(value) : '–');
      row.append(readonly);
      rowRefs.set(player.id, { tag, input: null, readonly, liveDot });
    }

    wrap.append(row);
  });
}

const rowRefs = new Map();

function updateRowTag(playerId, value) {
  const ref = rowRefs.get(playerId);
  if (!ref) return;
  const par = state.round.pars[state.hole - 1];
  if (typeof value === 'number') {
    ref.tag.className = tagClass(value, par);
    ref.tag.textContent = labelFor(value, par);
  } else {
    // No pill at all when there is no score — the row already shows a dash.
    ref.tag.className = 'tag gone';
    ref.tag.textContent = '';
  }
}

/* ---- saving -------------------------------------------------------
 * Every edit is queued by hole+player and flushed as a batch. A single
 * shared debounce timer would cancel earlier saves when scores are entered
 * quickly in a row, silently losing strokes, so nothing leaves `pending`
 * until the server has confirmed it.
 * ------------------------------------------------------------------ */

const pending = new Map();
let saveTimer;
let saveChain = Promise.resolve();

function saveScore(playerId, value) {
  const hole = state.hole;
  state.round.scores[playerId][hole - 1] = value; // optimistic
  updateRowTag(playerId, value);
  renderDots();
  renderLiveStandings();

  pending.set(hole + ':' + playerId, { hole, playerId, value });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushScores, 300);
}

function flushScores() {
  clearTimeout(saveTimer);
  if (pending.size === 0 || !state.round) return saveChain;

  const batch = [...pending.values()];
  pending.clear();

  const byHole = new Map();
  batch.forEach(({ hole, playerId, value }) => {
    if (!byHole.has(hole)) byHole.set(hole, {});
    byHole.get(hole)[playerId] = value;
  });

  const roundId = state.round.id;
  saveChain = saveChain.then(async () => {
    try {
      for (const [hole, scores] of byHole) {
        const data = await api('/rounds/' + roundId + '/scores', {
          method: 'PUT',
          body: { hole, scores, deviceId },
        });
        state.results = data.results;
      }
      renderLiveStandings();
      if (!$('#scorecard-card').hidden) renderScorecard();
    } catch (err) {
      batch.forEach((item) => {
        const key = item.hole + ':' + item.playerId;
        if (!pending.has(key)) pending.set(key, item);
      });
      toast('Not saved: ' + err.message);
    }
  });

  return saveChain;
}

function computeLocalTotals() {
  const round = state.round;
  return round.players.map((player) => {
    let strokes = 0, parPlayed = 0, holesPlayed = 0;
    round.scores[player.id].forEach((value, i) => {
      if (typeof value !== 'number') return;
      strokes += value;
      parPlayed += round.pars[i];
      holesPlayed++;
    });
    return { id: player.id, name: player.name, strokes, toPar: strokes - parPlayed, holesPlayed };
  });
}

function renderLiveStandings() {
  const list = $('#live-list');
  list.innerHTML = '';
  const mine = me();
  const totals = computeLocalTotals()
    .filter((p) => p.holesPlayed > 0)
    .sort((a, b) => a.toPar - b.toPar || a.strokes - b.strokes);

  if (totals.length === 0) {
    list.append(el('li', 'empty', 'No scores yet'));
    return;
  }

  totals.forEach((p, i) => {
    const li = el('li', mine && p.id === mine.id ? 'me-row' : '');
    li.append(el('span', 'pos', String(i + 1)));
    li.append(el('span', 'who', p.name));
    const val = el('span', 'val', parText(p.toPar));
    val.append(el('span', 'sub', '· ' + p.strokes + ' strokes · ' + p.holesPlayed + 'h'));
    li.append(val);
    list.append(li);
  });
}

function buildScoreTable(round, results) {
  const table = el('table', 'scorecard');
  const thead = el('thead');

  const headRow = el('tr');
  headRow.append(el('th', null, 'Hole'));
  for (let i = 1; i <= round.holes; i++) headRow.append(el('th', null, String(i)));
  headRow.append(el('th', null, 'Tot'));
  headRow.append(el('th', null, '+/-'));
  thead.append(headRow);

  const parRow = el('tr');
  parRow.append(el('th', null, 'Par'));
  round.pars.forEach((p) => parRow.append(el('th', null, String(p))));
  parRow.append(el('th', null, String(results.coursePar)));
  parRow.append(el('th', null, ''));
  thead.append(parRow);
  table.append(thead);

  const tbody = el('tbody');
  results.players.forEach((player) => {
    const tr = el('tr');
    tr.append(el('td', null, player.name));
    for (let i = 0; i < round.holes; i++) {
      const hole = player.holes[i];
      if (!hole) { tr.append(el('td', null, '–')); continue; }
      tr.append(el('td', cellClass(hole.strokes, hole.par), String(hole.strokes)));
    }
    tr.append(el('td', 'total', String(player.strokes)));
    tr.append(el('td', 'total', player.toParText));
    tbody.append(tr);
  });
  table.append(tbody);
  return table;
}

function renderScorecard() {
  $('#scorecard-card .table-wrap').replaceChildren(buildScoreTable(state.round, state.results));
}

/* ================================================================== */
/* Result                                                              */
/* ================================================================== */

const MEDALS = ['🥇', '🥈', '🥉'];

function renderResult() {
  const { round, results } = state;
  $('#result-course').textContent = round.course + ' · ' + round.holes + ' holes · par ' + results.coursePar;

  if (results.standings.length === 0) $('#result-title').textContent = 'No scores registered';
  else if (results.isTie) $('#result-title').textContent = 'Tie: ' + results.winners.join(' & ');
  else $('#result-title').textContent = results.winners[0] + ' wins!';

  const podium = $('#podium');
  podium.innerHTML = '';
  results.standings.forEach((p) => {
    const row = el('div', 'podium-row' + (p.rank === 1 ? ' first' : ''));
    row.append(el('div', 'medal', MEDALS[p.rank - 1] || p.rank + '.'));
    row.append(el('div', 'pname', p.name));
    const score = el('div', 'pscore', String(p.strokes));
    score.append(el('span', 'ppar', '(' + p.toParText + ')'));
    row.append(score);
    podium.append(row);
  });

  const table = buildScoreTable(round, results);
  table.id = 'result-table';
  $('#result-table').replaceWith(table);

  const stats = $('#result-stats');
  stats.innerHTML = '';
  results.players.forEach((p) => {
    const card = el('div', 'stat-card');
    card.append(el('h4', null, p.name));
    const ul = el('ul');
    [
      ['Total', p.strokes + ' (' + p.toParText + ')'],
      ['Avg / hole', String(p.average)],
      ['Aces', String(p.breakdown.ace)],
      ['Eagles', String(p.breakdown.eagle + p.breakdown.albatross)],
      ['Birdies', String(p.breakdown.birdie)],
      ['Pars', String(p.breakdown.par)],
      ['Bogeys', String(p.breakdown.bogey)],
      ['Double+', String(p.breakdown.doubleBogey + p.breakdown.tripleOrWorse)],
    ].forEach(([k, v]) => {
      const li = el('li');
      li.append(document.createTextNode(k));
      li.append(el('b', null, v));
      ul.append(li);
    });
    card.append(ul);
    stats.append(card);
  });
}

async function finishRound() {
  if (!confirm('Finish the round for everyone?')) return;
  try {
    await flushScores();
    if (pending.size > 0) throw new Error('Some scores are not saved yet');
    const data = await api('/rounds/' + state.round.id + '/finish', { method: 'POST', body: { deviceId } });
    setRound(data);
    renderResult();
    showView('result');
  } catch (err) {
    toast(err.message);
  }
}

/* ================================================================== */
/* History + stats                                                     */
/* ================================================================== */

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

async function renderHistory() {
  const list = $('#history-list');
  list.replaceChildren(el('p', 'empty', 'Loading…'));
  try {
    const rounds = await api('/rounds');
    list.innerHTML = '';
    if (rounds.length === 0) {
      list.append(el('p', 'empty', 'No rounds yet.'));
      return;
    }
    rounds.forEach((r) => {
      const item = el('div', 'history-item');
      const top = el('div', 'hi-top');
      top.append(el('div', 'hi-course', r.course));
      top.append(el('span', 'badge' + (r.status === 'active' ? ' live' : ''),
        r.status === 'active' ? (r.online ? r.online + ' online' : 'In progress') : 'Finished'));
      item.append(top);
      item.append(el('div', 'hi-date', formatDate(r.createdAt) + ' · ' + r.holes + ' holes · par ' + r.coursePar +
        (r.status === 'active' ? ' · code ' + r.code : '')));
      item.append(el('div', 'hi-players', r.players.join(', ')));
      if (r.standings.length) {
        const best = r.standings[0];
        item.append(el('div', 'hi-winner',
          (r.status === 'active' ? 'Leading: ' : 'Winner: ') + r.winners.join(' & ') +
          ' — ' + best.strokes + ' (' + best.toParText + ')'));
      }
      item.addEventListener('click', () => openRound(r.id));
      list.append(item);
    });
  } catch (err) {
    list.replaceChildren(el('p', 'empty', err.message));
  }
}

async function openRound(id) {
  try {
    const data = await api('/rounds/' + id);
    enterRound(data);
  } catch (err) {
    toast(err.message);
  }
}

async function renderStats() {
  const table = $('#stats-table');
  table.innerHTML = '';
  const old = $('#stats-empty');
  if (old) old.remove();
  try {
    const stats = await api('/stats');
    if (stats.length === 0) {
      const note = el('p', 'empty', 'Finish a round to build the leaderboard.');
      note.id = 'stats-empty';
      table.after(note);
      return;
    }
    const thead = el('thead');
    const hr = el('tr');
    ['Player', 'Rnds', 'Wins', 'Avg +/-', 'Avg/h', 'Bird+'].forEach((h) => hr.append(el('th', null, h)));
    thead.append(hr);
    table.append(thead);

    const tbody = el('tbody');
    stats.forEach((s) => {
      const tr = el('tr');
      tr.append(el('td', null, s.name));
      tr.append(el('td', null, String(s.rounds)));
      tr.append(el('td', 'total', String(s.wins)));
      tr.append(el('td', null, parText(s.avgToPar)));
      tr.append(el('td', null, String(s.avgPerHole)));
      tr.append(el('td', null, String(s.birdiesOrBetter)));
      tbody.append(tr);
    });
    table.append(tbody);
  } catch (err) {
    toast(err.message);
  }
}

/* ================================================================== */
/* Resume card on home                                                 */
/* ================================================================== */

async function renderResume() {
  const id = localStorage.getItem(ACTIVE_KEY);
  const card = $('#resume-card');
  if (!id) { card.hidden = true; return; }
  try {
    const data = await api('/rounds/' + id);
    if (data.round.status === 'finished') { card.hidden = true; return; }
    card.hidden = false;
    const body = $('#resume-body');
    body.innerHTML = '';
    const btn = el('button', 'btn big',
      data.round.course + ' · code ' + data.round.code);
    btn.type = 'button';
    btn.addEventListener('click', () => enterRound(data));
    body.append(btn);
  } catch {
    localStorage.removeItem(ACTIVE_KEY);
    card.hidden = true;
  }
}

/* ================================================================== */
/* Wiring                                                              */
/* ================================================================== */

function init() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view;
      if (state.view === 'play') flushScores();
      if (view === 'history') renderHistory();
      if (view === 'stats') renderStats();
      if (view === 'home') {
        if (state.round && state.round.status === 'active') { renderPlay(); showView('play'); return; }
        renderResume();
      }
      showView(view);
    });
  });

  $$('[data-back]').forEach((b) => b.addEventListener('click', () => {
    renderResume();
    showView(b.dataset.back);
  }));

  // home
  $('#go-create').addEventListener('click', () => {
    $('#host-name').value = localStorage.getItem(NAME_KEY) || '';
    showView('create');
  });
  $('#go-join').addEventListener('click', () => showView('join'));

  // create
  $('#add-player').addEventListener('click', () => addPlayerRow());
  $('#holes').addEventListener('change', () => {
    buildParGrid();
    $$('#hole-presets .chip').forEach((c) => c.classList.toggle('active', c.dataset.holes === $('#holes').value));
  });
  $$('#hole-presets .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('#holes').value = chip.dataset.holes;
      $('#holes').dispatchEvent(new Event('change'));
    });
  });
  $('#start-round').addEventListener('click', createRound);

  // join
  $('#join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (e.target.value.length === 4) findRound();
  });
  $('#find-round').addEventListener('click', findRound);
  $('#join-as-new').addEventListener('click', joinAsNew);

  // lobby
  $('#share-link').addEventListener('click', shareRound);
  $('#copy-link').addEventListener('click', copyLink);
  $('#lobby-start').addEventListener('click', () => {
    state.hole = firstUnplayedHole(state.round);
    renderPlay();
    showView('play');
  });

  // play
  $('#open-lobby').addEventListener('click', () => { renderLobby(); showView('lobby'); });
  $('#prev-hole').addEventListener('click', () => {
    if (state.hole > 1) { flushScores(); state.hole--; renderPlay(); }
  });
  $('#next-hole').addEventListener('click', () => {
    if (state.hole < state.round.holes) { flushScores(); state.hole++; renderPlay(); }
  });
  $('#me-minus').addEventListener('click', () => bumpMyScore(-1));
  $('#me-plus').addEventListener('click', () => bumpMyScore(1));
  $('#edit-all').addEventListener('change', renderScoreRows);

  $('#scorecard-toggle').addEventListener('click', () => {
    const card = $('#scorecard-card');
    card.hidden = !card.hidden;
    $('#scorecard-toggle').textContent = card.hidden ? 'Show full scorecard' : 'Hide scorecard';
    if (!card.hidden) renderScorecard();
  });

  $('#finish-round').addEventListener('click', finishRound);

  $('#leave-round').addEventListener('click', async () => {
    try {
      await flushScores();
      await api('/rounds/' + state.round.id + '/leave', { method: 'POST', body: { deviceId } });
    } catch { /* leaving is best-effort */ }
    clearActiveRound();
    renderResume();
    showView('home');
    toast('Left the round');
  });

  $('#abandon-round').addEventListener('click', async () => {
    if (!confirm('Delete this round for everyone?')) return;
    try {
      await api('/rounds/' + state.round.id, { method: 'DELETE' });
      clearActiveRound();
      renderResume();
      showView('home');
      toast('Round deleted');
    } catch (err) {
      toast(err.message);
    }
  });

  // result
  $('#result-new').addEventListener('click', () => {
    clearActiveRound();
    $('#host-name').value = localStorage.getItem(NAME_KEY) || '';
    showView('create');
  });
  $('#result-reopen').addEventListener('click', async () => {
    try {
      const data = await api('/rounds/' + state.round.id + '/reopen', { method: 'POST', body: { deviceId } });
      setRound(data);
      rememberActiveRound(data.round.id);
      renderPlay();
      showView('play');
    } catch (err) {
      toast(err.message);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (state.view !== 'play' || !state.round) return;
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft' && state.hole > 1) { state.hole--; renderPlay(); }
    if (e.key === 'ArrowRight' && state.hole < state.round.holes) { state.hole++; renderPlay(); }
  });

  // A phone locking its screen suspends the connection; refresh on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.round) {
      connectLive(state.round.id);
      flushScores();
    }
  });

  window.addEventListener('pagehide', () => { flushScores(); });

  addPlayerRow('', false);
  buildParGrid();

  // A shared link looks like http://192.168.0.5:3000/?code=AB12
  const codeParam = new URLSearchParams(location.search).get('code');
  if (codeParam) {
    history.replaceState(null, '', location.pathname);
    $('#join-code').value = codeParam.toUpperCase().slice(0, 4);
    showView('join');
    findRound();
    return;
  }

  showView('home');
  renderResume();
}

document.addEventListener('DOMContentLoaded', init);
