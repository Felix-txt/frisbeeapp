'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rounds.json');

/* ================================================================== */
/* Storage                                                             */
/*                                                                     */
/* Everything lives in memory and is flushed to disk on a short debounce.*/
/* With several phones writing at once, the old read-file/modify/       */
/* write-file-per-request approach could interleave and lose strokes.   */
/* A single in-process source of truth removes that class of bug.       */
/* ================================================================== */

/** @type {Map<string, object>} */
const rounds = new Map();
/** @type {Map<string, string>} joinCode -> roundId */
const codeIndex = new Map();

let flushTimer = null;
let flushChain = Promise.resolve();

function scheduleFlush() {
  if (flushTimer) return flushChain;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushChain = flushChain.then(persist).catch((e) => console.error('Persist failed:', e.message));
  }, 400);
  return flushChain;
}

async function persist() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify([...rounds.values()], null, 2), 'utf8');
  await fsp.rename(tmp, DATA_FILE);
}

async function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushChain = flushChain.then(persist);
  return flushChain;
}

function loadFromDisk() {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read data file:', err.message);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('Data file is corrupt, starting fresh (old file kept as .bak)');
    try { fs.renameSync(DATA_FILE, DATA_FILE + '.bak'); } catch {}
    return;
  }

  if (!Array.isArray(parsed)) return;
  for (const round of parsed) {
    normalizeRound(round);
    rounds.set(round.id, round);
    codeIndex.set(round.code, round.id);
  }
  console.log(`Loaded ${rounds.size} saved round(s).`);
}

/** Fills in fields added after a round was first written. */
function normalizeRound(round) {
  if (!round.code || codeIndex.has(round.code)) round.code = makeJoinCode();
  if (typeof round.allowJoin !== 'boolean') round.allowJoin = round.status !== 'finished';
  round.players.forEach((p) => {
    if (!('deviceId' in p)) p.deviceId = null;
  });
  return round;
}

/* ================================================================== */
/* Join codes                                                          */
/* ================================================================== */

// No I/O/0/1 — they get misread when someone reads the code out loud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeJoinCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    if (!codeIndex.has(code)) return code;
  }
  return crypto.randomUUID().slice(0, 6).toUpperCase();
}

/* ================================================================== */
/* Live sync (Server-Sent Events)                                      */
/* ================================================================== */

/** @type {Map<string, Set<object>>} roundId -> set of subscriber objects */
const channels = new Map();

function subscribe(roundId, client) {
  if (!channels.has(roundId)) channels.set(roundId, new Set());
  channels.get(roundId).add(client);
}

function unsubscribe(roundId, client) {
  const set = channels.get(roundId);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) channels.delete(roundId);
}

function presenceFor(roundId) {
  const set = channels.get(roundId);
  if (!set) return [];
  const seen = new Map();
  for (const client of set) {
    if (!client.deviceId) continue;
    seen.set(client.deviceId, { deviceId: client.deviceId, playerId: client.playerId });
  }
  return [...seen.values()];
}

function broadcast(roundId, event, payload, exclude) {
  const set = channels.get(roundId);
  if (!set || set.size === 0) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of set) {
    if (client === exclude) continue;
    try {
      client.res.write(frame);
    } catch {
      unsubscribe(roundId, client);
    }
  }
}

/** Pushes the authoritative round state to every connected phone. */
function broadcastRound(round, origin) {
  broadcast(round.id, 'round', {
    round,
    results: calculateResults(round),
    presence: presenceFor(round.id),
    origin: origin || null,
  });
}

function broadcastPresence(roundId) {
  broadcast(roundId, 'presence', { presence: presenceFor(roundId) });
}

/* ================================================================== */
/* Domain logic                                                        */
/* ================================================================== */

function scoreLabel(strokes, par) {
  if (strokes === 1) return 'Ace';
  const diff = strokes - par;
  if (diff <= -3) return 'Albatross';
  if (diff === -2) return 'Eagle';
  if (diff === -1) return 'Birdie';
  if (diff === 0) return 'Par';
  if (diff === 1) return 'Bogey';
  if (diff === 2) return 'Double bogey';
  if (diff === 3) return 'Triple bogey';
  return '+' + diff;
}

function formatToPar(n) {
  if (n === 0) return 'E';
  return n > 0 ? '+' + n : String(n);
}

function calculateResults(round) {
  const pars = round.pars;

  const players = round.players.map((player) => {
    const scores = round.scores[player.id] || [];
    let strokes = 0;
    let parPlayed = 0;
    let holesPlayed = 0;
    const breakdown = {
      ace: 0, albatross: 0, eagle: 0, birdie: 0,
      par: 0, bogey: 0, doubleBogey: 0, tripleOrWorse: 0,
    };
    const holes = [];

    for (let i = 0; i < round.holes; i++) {
      const value = scores[i];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        holes.push(null);
        continue;
      }
      holesPlayed++;
      strokes += value;
      parPlayed += pars[i];

      const diff = value - pars[i];
      if (value === 1) breakdown.ace++;
      else if (diff <= -3) breakdown.albatross++;
      else if (diff === -2) breakdown.eagle++;
      else if (diff === -1) breakdown.birdie++;
      else if (diff === 0) breakdown.par++;
      else if (diff === 1) breakdown.bogey++;
      else if (diff === 2) breakdown.doubleBogey++;
      else breakdown.tripleOrWorse++;

      holes.push({ hole: i + 1, par: pars[i], strokes: value, diff, label: scoreLabel(value, pars[i]) });
    }

    const toPar = strokes - parPlayed;
    return {
      id: player.id,
      name: player.name,
      deviceId: player.deviceId || null,
      strokes,
      holesPlayed,
      toPar,
      toParText: formatToPar(toPar),
      breakdown,
      holes,
      average: holesPlayed ? Number((strokes / holesPlayed).toFixed(2)) : 0,
    };
  });

  // Rank on score-to-par, not raw strokes: mid-round, players may have
  // completed a different number of holes and fewer holes must not look
  // like a lead. For a completed round both orderings are identical.
  const played = players.filter((p) => p.holesPlayed > 0);
  const sorted = [...played].sort(
    (a, b) => a.toPar - b.toPar || a.strokes - b.strokes || a.name.localeCompare(b.name)
  );

  let lastKey = null;
  let lastRank = 0;
  const standings = sorted.map((p, index) => {
    const key = p.toPar + ':' + p.strokes;
    const rank = key === lastKey ? lastRank : index + 1;
    lastKey = key;
    lastRank = rank;
    return { ...p, rank };
  });

  const winners = standings.filter((p) => p.rank === 1).map((p) => p.name);

  return {
    coursePar: pars.reduce((a, b) => a + b, 0),
    totalHoles: round.holes,
    players,
    standings,
    winners,
    isTie: winners.length > 1,
    complete: players.length > 0 && players.every((p) => p.holesPlayed === round.holes),
  };
}

/* ================================================================== */
/* Validation                                                          */
/* ================================================================== */

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

const badRequest = (m) => httpError(400, m);

function cleanName(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').slice(0, 24);
}

function buildRound(body) {
  const course = cleanName(body.course) || 'Unnamed course';
  const holes = Number(body.holes);
  if (!Number.isInteger(holes) || holes < 1 || holes > 36) {
    throw badRequest('Holes must be a whole number between 1 and 36');
  }

  const names = Array.isArray(body.players) ? body.players.map(cleanName).filter(Boolean) : [];
  if (names.length === 0) throw badRequest('Add at least one player');
  if (names.length > 12) throw badRequest('Max 12 players per round');
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) {
    throw badRequest('Player names must be unique');
  }

  let pars;
  if (Array.isArray(body.pars) && body.pars.length === holes) {
    pars = body.pars.map(Number);
    if (pars.some((p) => !Number.isInteger(p) || p < 2 || p > 8)) {
      throw badRequest('Every par must be a whole number between 2 and 8');
    }
  } else {
    pars = new Array(holes).fill(3);
  }

  const hostDevice = body.deviceId ? String(body.deviceId).slice(0, 64) : null;
  const players = names.map((name, i) => ({
    id: crypto.randomUUID(),
    name,
    // The creator automatically owns the first seat so they don't have to claim it.
    deviceId: i === 0 ? hostDevice : null,
  }));

  const scores = {};
  players.forEach((p) => { scores[p.id] = new Array(holes).fill(null); });

  return {
    id: crypto.randomUUID(),
    code: makeJoinCode(),
    course,
    holes,
    pars,
    players,
    scores,
    hostDeviceId: hostDevice,
    allowJoin: true,
    status: 'active',
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
}

function normalizeStroke(raw) {
  if (raw === null || raw === '' || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 30) {
    throw badRequest('Strokes must be a whole number between 1 and 30');
  }
  return n;
}

function applyScores(round, body) {
  const incoming = body.scores;
  if (!incoming || typeof incoming !== 'object') throw badRequest('scores is required');
  const validIds = new Set(round.players.map((p) => p.id));

  if (body.hole !== undefined) {
    const hole = Number(body.hole);
    if (!Number.isInteger(hole) || hole < 1 || hole > round.holes) {
      throw badRequest('Hole must be between 1 and ' + round.holes);
    }
    for (const [playerId, raw] of Object.entries(incoming)) {
      if (!validIds.has(playerId)) throw badRequest('Unknown player');
      round.scores[playerId][hole - 1] = normalizeStroke(raw);
    }
    return round;
  }

  for (const [playerId, arr] of Object.entries(incoming)) {
    if (!validIds.has(playerId)) throw badRequest('Unknown player');
    if (!Array.isArray(arr) || arr.length !== round.holes) {
      throw badRequest('Score list must have ' + round.holes + ' entries');
    }
    round.scores[playerId] = arr.map(normalizeStroke);
  }
  return round;
}

/**
 * A phone either claims one of the empty seats the host typed in, or adds
 * itself as a brand new player.
 */
function joinRound(round, body) {
  const deviceId = String(body.deviceId || '').slice(0, 64);
  if (!deviceId) throw badRequest('deviceId is required');
  if (round.status === 'finished') throw httpError(409, 'That round is already finished');
  if (!round.allowJoin) throw httpError(409, 'The host closed this round for new players');

  // Already in? Just hand back the existing seat (makes join idempotent).
  const existing = round.players.find((p) => p.deviceId === deviceId);
  if (existing && !body.playerId) return existing;

  if (body.playerId) {
    const seat = round.players.find((p) => p.id === body.playerId);
    if (!seat) throw httpError(404, 'That player is not in this round');
    if (seat.deviceId && seat.deviceId !== deviceId) {
      throw httpError(409, `${seat.name} is already taken by another phone`);
    }
    // Free whatever seat this device held before.
    round.players.forEach((p) => { if (p.deviceId === deviceId && p.id !== seat.id) p.deviceId = null; });
    seat.deviceId = deviceId;
    if (body.name) seat.name = cleanName(body.name) || seat.name;
    return seat;
  }

  const name = cleanName(body.name);
  if (!name) throw badRequest('Enter your name');
  if (round.players.length >= 12) throw badRequest('This round is full (12 players)');
  if (round.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    throw badRequest('Someone is already called ' + name + ' — pick their seat or use another name');
  }

  const player = { id: crypto.randomUUID(), name, deviceId };
  round.players.push(player);
  round.scores[player.id] = new Array(round.holes).fill(null);
  return player;
}

/* ================================================================== */
/* HTTP helpers                                                        */
/* ================================================================== */

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(badRequest('Body too large'));
        req.destroy();
      }
    });
    req.on('error', reject);
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(badRequest('Invalid JSON body')); }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  // Any unknown path falls back to the app shell so /join links work.
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  let filePath = path.join(PUBLIC_DIR, relative);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      if (path.extname(relative)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      filePath = path.join(PUBLIC_DIR, 'index.html'); // SPA fallback
      return fs.stat(filePath, (e2, s2) => {
        if (e2 || !s2.isFile()) return res.writeHead(404).end('Not found');
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': s2.size });
        fs.createReadStream(filePath).pipe(res);
      });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ================================================================== */
/* SSE endpoint                                                        */
/* ================================================================== */

function handleEvents(req, res, round, query) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const client = {
    res,
    deviceId: query.get('deviceId') || null,
    playerId: query.get('playerId') || null,
  };

  subscribe(round.id, client);
  res.write('retry: 2000\n\n');
  res.write(`event: round\ndata: ${JSON.stringify({
    round,
    results: calculateResults(round),
    presence: presenceFor(round.id),
  })}\n\n`);
  broadcastPresence(round.id);

  // Proxies and phone radios drop idle connections; a comment every 25s keeps it warm.
  const beat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* cleaned up on close */ }
  }, 25000);

  const cleanup = () => {
    clearInterval(beat);
    unsubscribe(round.id, client);
    broadcastPresence(round.id);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
}

/* ================================================================== */
/* API routes                                                          */
/* ================================================================== */

function summarize(round) {
  const results = calculateResults(round);
  return {
    id: round.id,
    code: round.code,
    course: round.course,
    holes: round.holes,
    status: round.status,
    createdAt: round.createdAt,
    finishedAt: round.finishedAt,
    players: round.players.map((p) => p.name),
    coursePar: results.coursePar,
    winners: results.winners,
    online: presenceFor(round.id).length,
    standings: results.standings.map((s) => ({
      name: s.name, strokes: s.strokes, toPar: s.toPar, toParText: s.toParText, rank: s.rank,
    })),
  };
}

const withResults = (round) => ({
  round,
  results: calculateResults(round),
  presence: presenceFor(round.id),
});

async function handleApi(req, res, pathname, query) {
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  /* ---- /api/rounds ---- */
  if (seg.length === 2 && seg[1] === 'rounds') {
    if (method === 'GET') {
      const list = [...rounds.values()]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map(summarize);
      return sendJson(res, 200, list);
    }
    if (method === 'POST') {
      const round = buildRound(await readBody(req));
      rounds.set(round.id, round);
      codeIndex.set(round.code, round.id);
      scheduleFlush();
      return sendJson(res, 201, withResults(round));
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  /* ---- /api/rounds/code/:code ---- */
  if (seg.length === 4 && seg[1] === 'rounds' && seg[2] === 'code' && method === 'GET') {
    const code = String(seg[3] || '').toUpperCase();
    const id = codeIndex.get(code);
    if (!id) return sendJson(res, 404, { error: 'No round found with code ' + code });
    return sendJson(res, 200, withResults(rounds.get(id)));
  }

  /* ---- /api/stats ---- */
  if (seg.length === 2 && seg[1] === 'stats' && method === 'GET') {
    const table = new Map();
    for (const round of rounds.values()) {
      if (round.status !== 'finished') continue;
      for (const player of calculateResults(round).standings) {
        const key = player.name.toLowerCase();
        const e = table.get(key) || {
          name: player.name, rounds: 0, wins: 0, strokes: 0, holes: 0, toPar: 0, birdiesOrBetter: 0,
        };
        e.rounds++;
        if (player.rank === 1) e.wins++;
        e.strokes += player.strokes;
        e.holes += player.holesPlayed;
        e.toPar += player.toPar;
        e.birdiesOrBetter += player.breakdown.ace + player.breakdown.albatross +
          player.breakdown.eagle + player.breakdown.birdie;
        table.set(key, e);
      }
    }
    const stats = [...table.values()]
      .map((e) => ({
        ...e,
        toParText: formatToPar(e.toPar),
        avgPerHole: e.holes ? Number((e.strokes / e.holes).toFixed(2)) : 0,
        avgToPar: e.rounds ? Number((e.toPar / e.rounds).toFixed(1)) : 0,
      }))
      .sort((a, b) => b.wins - a.wins || a.avgToPar - b.avgToPar);
    return sendJson(res, 200, stats);
  }

  /* ---- /api/rounds/:id[/action] ---- */
  if (seg.length >= 3 && seg[1] === 'rounds') {
    const round = rounds.get(seg[2]);
    const action = seg[3];
    if (!round) return sendJson(res, 404, { error: 'Round not found' });

    if (action === 'events' && method === 'GET') return handleEvents(req, res, round, query);

    if (!action && method === 'GET') return sendJson(res, 200, withResults(round));

    if (!action && method === 'DELETE') {
      rounds.delete(round.id);
      codeIndex.delete(round.code);
      broadcast(round.id, 'deleted', { id: round.id });
      scheduleFlush();
      return sendJson(res, 200, { deleted: round.id });
    }

    if (action === 'join' && method === 'POST') {
      const body = await readBody(req);
      const player = joinRound(round, body);
      scheduleFlush();
      broadcastRound(round, body.deviceId);
      return sendJson(res, 200, { ...withResults(round), you: player });
    }

    if (action === 'leave' && method === 'POST') {
      const body = await readBody(req);
      const deviceId = String(body.deviceId || '');
      const seat = round.players.find((p) => p.deviceId === deviceId);
      if (seat) seat.deviceId = null;
      scheduleFlush();
      broadcastRound(round, deviceId);
      return sendJson(res, 200, withResults(round));
    }

    if (action === 'scores' && ['PUT', 'PATCH', 'POST'].includes(method)) {
      if (round.status === 'finished') return sendJson(res, 409, { error: 'Round is already finished' });
      const body = await readBody(req);
      applyScores(round, body);
      scheduleFlush();
      broadcastRound(round, body.deviceId);
      return sendJson(res, 200, withResults(round));
    }

    if (action === 'finish' && method === 'POST') {
      const body = await readBody(req);
      round.status = 'finished';
      round.allowJoin = false;
      round.finishedAt = new Date().toISOString();
      scheduleFlush();
      broadcastRound(round, body.deviceId);
      return sendJson(res, 200, withResults(round));
    }

    if (action === 'reopen' && method === 'POST') {
      const body = await readBody(req);
      round.status = 'active';
      round.allowJoin = true;
      round.finishedAt = null;
      scheduleFlush();
      broadcastRound(round, body.deviceId);
      return sendJson(res, 200, withResults(round));
    }

    if (action === 'lock' && method === 'POST') {
      const body = await readBody(req);
      round.allowJoin = !!body.allowJoin;
      scheduleFlush();
      broadcastRound(round, body.deviceId);
      return sendJson(res, 200, withResults(round));
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  return sendJson(res, 404, { error: 'Unknown endpoint' });
}

/* ================================================================== */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url.pathname, url.searchParams);
    } catch (err) {
      const status = err.statusCode || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: err.message || 'Server error' });
    }
    return;
  }

  serveStatic(req, res);
});

server.headersTimeout = 0;
server.requestTimeout = 0; // SSE connections are long-lived

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

// Inside a container the only addresses we can see are the private bridge
// ones, which are useless to a phone — so print guidance instead of a lie.
const inContainer = fs.existsSync('/.dockerenv') || process.env.container === 'docker';

if (require.main === module) {
  loadFromDisk();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  Disc Golf Scorecard\n');

    if (inContainer) {
      console.log(`  Listening on port ${PORT} inside the container.`);
      console.log('  Reach it at the address you published, e.g. http://<server-ip>:3000\n');
      return;
    }

    const ips = localAddresses();
    console.log(`  On this computer:  http://localhost:${PORT}`);
    if (ips.length) {
      console.log('  On your phone:     ' + ips.map((ip) => `http://${ip}:${PORT}`).join('\n                     '));
      console.log('\n  (phones must be on the same Wi-Fi)\n');
    } else {
      console.log('\n  No network connection found — phones will not be able to reach this.\n');
    }
  });

  const shutdown = async () => {
    console.log('\nSaving…');
    try { await flushNow(); } catch (e) { console.error(e.message); }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { server, calculateResults, buildRound, applyScores, joinRound, rounds, codeIndex, loadFromDisk };
