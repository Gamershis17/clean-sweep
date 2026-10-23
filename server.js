'use strict';
/* =====================================================================
   CLEAN SWEEP — co-op server
   - Serves the game (public/) and runs WebSocket rooms of 2-4 cleaners.
   - The server owns each room's shared dirt grid (clients predict locally,
     server values win via absolute deltas + full snapshots).
   - Bags / cash / gear stay on each player's device (their local save),
     exactly like single player. The server runs the ROOM, not wallets.
   - Owner troll console at /admin.html, key = ADMIN_KEY env var
     (or a key generated at boot and printed once in the server log).
   ===================================================================== */
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3100;
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(6).toString('hex');

// ---- shared game config (mirrors the client) ----
const W = 960, H = 540, CELL = 30, COLS = 32, ROWS = 18, NCELLS = COLS * ROWS;
const PAD = { x: W / 2 - 78, y: H - 74, w: 156, h: 74 };
const ROOM_DEFS = [
  { name: 'Messy Apartment', price: 1,   bonus: 150,  splats: 80  },
  { name: 'Trashed Café',    price: 2.5, bonus: 500,  splats: 95  },
  { name: 'Muddy Garage',    price: 6,   bonus: 1800, splats: 110 },
  { name: 'Haunted Mansion', price: 15,  bonus: 7500, splats: 130 },
];
const BRUSHES = [
  { r: 26, s: 0.55 }, { r: 34, s: 0.85 }, { r: 42, s: 1.15 },
  { r: 50, s: 1.55 }, { r: 58, s: 2.05 }, { r: 68, s: 2.75 },
];
const DRONE_BRUSH = { r: 21, s: 0.5 };
const MAX_PER_ROOM = 4;
const COLORS = ['#2f9e8f', '#e0658a', '#5cc8ff', '#ffb84d'];

// ---- dirt grid helpers (same generation as the client) ----
function genGrid(roomIdx) {
  const def = ROOM_DEFS[roomIdx];
  const grid = new Float32Array(NCELLS);
  for (let i = 0; i < NCELLS; i++) grid[i] = Math.random() * 0.18;
  addSplats(grid, def.splats);
  clearPadArea(grid);
  return grid;
}
function addSplats(grid, count) {
  for (let s = 0; s < count; s++) {
    const cx = (Math.random() * COLS) | 0, cy = (Math.random() * ROWS) | 0;
    const rad = 1 + Math.random() * 2.2, str = 0.45 + Math.random() * 0.55, r2 = Math.ceil(rad);
    for (let y = cy - r2; y <= cy + r2; y++) for (let x = cx - r2; x <= cx + r2; x++) {
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (d <= rad) { const i = y * COLS + x; grid[i] = Math.min(1, grid[i] + str * (1 - d / (rad + 0.6))); }
    }
  }
}
function clearPadArea(grid) {
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const px = x * CELL + CELL / 2, py = y * CELL + CELL / 2;
    if (px > PAD.x - 36 && px < PAD.x + PAD.w + 36 && py > PAD.y - 40) grid[y * COLS + x] *= 0.15;
  }
}
function gridTotal(grid) { let t = 0; for (let i = 0; i < NCELLS; i++) t += grid[i]; return Math.max(1, t); }
function gridToB64(grid) {
  const bytes = Buffer.alloc(NCELLS);
  for (let i = 0; i < NCELLS; i++) bytes[i] = Math.max(0, Math.min(255, Math.round(grid[i] * 255)));
  return bytes.toString('base64');
}
// server-side scrub: one fixed time slice (matches a client's ~120ms intent)
function scrubGrid(room, x, y, brush, dt) {
  const R = brush.r, rate = brush.s;
  let removed = 0;
  const minCx = Math.max(0, ((x - R) / CELL) | 0), maxCx = Math.min(COLS - 1, ((x + R) / CELL) | 0);
  const minCy = Math.max(0, ((y - R) / CELL) | 0), maxCy = Math.min(ROWS - 1, ((y + R) / CELL) | 0);
  for (let cy = minCy; cy <= maxCy; cy++) for (let cx = minCx; cx <= maxCx; cx++) {
    const i = cy * COLS + cx;
    if (room.grid[i] <= 0.005) continue;
    const d = Math.hypot(cx * CELL + CELL / 2 - x, cy * CELL + CELL / 2 - y);
    if (d > R + CELL * 0.4) continue;
    const fall = Math.max(0.25, 1 - (d / R) * 0.55);
    const amt = Math.min(room.grid[i], rate * dt * fall);
    if (amt <= 0) continue;
    room.grid[i] -= amt; removed += amt;
    room.changed.add(i);
  }
  if (removed > 0) room.remain = Math.max(0, room.remain - removed);
  return removed;
}

// ---- rooms ----
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
function makeCode() {
  let code;
  do { code = Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join(''); }
  while (rooms.has(code));
  return code;
}
function createRoom(roomIdx, isPrivate, hostId) {
  const grid = genGrid(roomIdx);
  const room = {
    code: makeCode(), private: !!isPrivate, roomIdx,
    grid, total: gridTotal(grid), remain: 0,
    players: new Map(), changed: new Set(),
    complete: false, hostId,
  };
  room.remain = room.total;
  rooms.set(room.code, room);
  return room;
}
function roomSnapshot(room) {
  return { t: 'snapshot', code: room.code, roomIdx: room.roomIdx, grid: gridToB64(room.grid), total: room.total, remain: room.remain };
}
function roomPlayers(room) {
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, x: Math.round(p.x), y: Math.round(p.y) }));
}

// ---- http ----
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/stats', (req, res) => {
  res.json({ online: clients.size, rooms: rooms.size, inRooms: [...rooms.values()].reduce((n, r) => n + r.players.size, 0) });
});
// owner troll console actions
app.post('/api/admin/troll', (req, res) => {
  const { key, kind, msg } = req.body || {};
  if (key !== ADMIN_KEY) return res.status(403).json({ ok: false, error: 'bad key' });
  const kinds = ['messbomb', 'slippery', 'duststorm', 'confetti', 'announce', 'fakerestart'];
  if (!kinds.includes(kind)) return res.status(400).json({ ok: false, error: 'unknown kind' });
  if (kind === 'messbomb') {
    for (const room of rooms.values()) {
      addSplats(room.grid, 30);
      room.total = gridTotal(room.grid); room.remain = room.total; room.complete = false;
      broadcastRoom(room, roomSnapshot(room));
    }
  }
  broadcastAll({ t: 'troll', kind, msg: String(msg || '').slice(0, 140) });
  console.log('[troll]', kind, msg || '');
  res.json({ ok: true, reached: clients.size });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---- websocket clients ----
const clients = new Set();
let nextId = 1;
function send(ws, obj) { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} } }
function broadcastAll(obj) { for (const c of clients) send(c.ws, obj); }
function broadcastRoom(room, obj, exceptId) {
  for (const p of room.players.values()) if (p.id !== exceptId) send(p.ws, obj);
}
function broadcastPresence() { broadcastAll({ t: 'presence', online: clients.size }); }
function lobbyData() {
  return {
    t: 'lobby', online: clients.size,
    rooms: [...rooms.values()].filter(r => !r.private)
      .map(r => ({ code: r.code, roomIdx: r.roomIdx, players: r.players.size, max: MAX_PER_ROOM })),
  };
}
function pushLobby() { for (const c of clients) if (!c.room) send(c.ws, lobbyData()); }
function leaveRoom(c) {
  const room = c.room;
  if (!room) return;
  room.players.delete(c.id);
  c.room = null;
  if (room.players.size === 0) { rooms.delete(room.code); }
  else {
    if (room.hostId === c.id) room.hostId = [...room.players.keys()][0];
    broadcastRoom(room, { t: 'players', players: roomPlayers(room), hostId: room.hostId });
  }
  pushLobby();
}
function joinRoom(c, room) {
  leaveRoom(c);
  const p = { id: c.id, ws: c.ws, name: c.name, color: COLORS[room.players.size % COLORS.length], x: W / 2, y: H - 130 };
  if (room.players.size === 0) room.hostId = c.id;
  room.players.set(c.id, p);
  c.room = room; c.player = p;
  send(c.ws, { t: 'joined', code: room.code, roomIdx: room.roomIdx, you: c.id, hostId: room.hostId, players: roomPlayers(room) });
  send(c.ws, roomSnapshot(room));
  broadcastRoom(room, { t: 'players', players: roomPlayers(room), hostId: room.hostId }, c.id);
  pushLobby();
}

wss.on('connection', (ws) => {
  const c = { id: nextId++, ws, name: 'Guest', room: null, player: null, lastScrub: 0, scrubCount: 0, scrubWindow: Date.now() };
  clients.add(c);
  send(ws, { t: 'welcome', id: c.id, online: clients.size });
  broadcastPresence(); pushLobby();

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'hello': {
        const name = String(m.name || 'Guest').replace(/[^\w\s\-!.]/g, '').trim().slice(0, 16);
        c.name = name || 'Guest';
        if (c.player) c.player.name = c.name;
        if (c.room) broadcastRoom(c.room, { t: 'players', players: roomPlayers(c.room), hostId: c.room.hostId });
        break;
      }
      case 'lobby': send(ws, lobbyData()); break;
      case 'create': {
        const roomIdx = Math.max(0, Math.min(ROOM_DEFS.length - 1, m.roomIdx | 0));
        joinRoom(c, createRoom(roomIdx, !!m.private, c.id));
        break;
      }
      case 'quick': {
        const want = Math.max(0, Math.min(ROOM_DEFS.length - 1, m.roomIdx | 0));
        let room = [...rooms.values()].find(r => !r.private && r.roomIdx === want && r.players.size < MAX_PER_ROOM)
                || [...rooms.values()].find(r => !r.private && r.players.size < MAX_PER_ROOM);
        if (!room) room = createRoom(want, false, c.id);
        joinRoom(c, room);
        break;
      }
      case 'join': {
        const room = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!room) { send(ws, { t: 'err', msg: 'Room not found — check the code.' }); break; }
        if (room.players.size >= MAX_PER_ROOM) { send(ws, { t: 'err', msg: 'That room is full (4 cleaners).' }); break; }
        joinRoom(c, room);
        break;
      }
      case 'leave': leaveRoom(c); send(ws, lobbyData()); break;
      case 'pos': {
        if (!c.room || !c.player) break;
        c.player.x = Math.max(0, Math.min(W, +m.x || 0));
        c.player.y = Math.max(0, Math.min(H, +m.y || 0));
        c.player.face = +m.face || 0;
        broadcastRoom(c.room, { t: 'pos', id: c.id, x: Math.round(c.player.x), y: Math.round(c.player.y), face: c.player.face }, c.id);
        break;
      }
      case 'scrub': {
        if (!c.room || c.room.complete) break;
        const now = Date.now();
        if (now - c.scrubWindow > 1000) { c.scrubWindow = now; c.scrubCount = 0; }
        if (++c.scrubCount > 14) break; // rate limit: ~14 intents/sec max
        const brush = m.brush === -1 ? DRONE_BRUSH : BRUSHES[Math.max(0, Math.min(BRUSHES.length - 1, m.brush | 0))];
        const x = Math.max(0, Math.min(W, +m.x || 0)), y = Math.max(0, Math.min(H, +m.y || 0));
        scrubGrid(c.room, x, y, brush, 0.12);
        if (!c.room.complete && c.room.remain <= Math.max(1.5, c.room.total * 0.004)) {
          c.room.complete = true;
          for (let i = 0; i < NCELLS; i++) if (c.room.grid[i] < 0.06) { if (c.room.grid[i] > 0.02) c.room.changed.add(i); c.room.grid[i] = 0; }
          c.room.remain = 0;
          broadcastRoom(c.room, { t: 'complete', bonus: ROOM_DEFS[c.room.roomIdx].bonus });
          broadcastRoom(c.room, roomSnapshot(c.room));
        }
        break;
      }
      case 'remess': {
        if (!c.room || c.room.hostId !== c.id) break;
        const room = c.room;
        room.grid = genGrid(room.roomIdx);
        room.total = gridTotal(room.grid); room.remain = room.total; room.complete = false; room.changed.clear();
        broadcastRoom(room, roomSnapshot(room));
        broadcastRoom(room, { t: 'event', msg: 'The room got trashed again! 🗑️' });
        break;
      }
      case 'nextroom': {
        if (!c.room || c.room.hostId !== c.id) break;
        const room = c.room;
        room.roomIdx = Math.min(ROOM_DEFS.length - 1, room.roomIdx + 1);
        room.grid = genGrid(room.roomIdx);
        room.total = gridTotal(room.grid); room.remain = room.total; room.complete = false; room.changed.clear();
        broadcastRoom(room, roomSnapshot(room));
        broadcastRoom(room, { t: 'event', msg: 'Next room: ' + ROOM_DEFS[room.roomIdx].name + ' 🏠' });
        break;
      }
    }
  });
  ws.on('close', () => { leaveRoom(c); clients.delete(c); broadcastPresence(); pushLobby(); });
  ws.on('error', () => { try { ws.close(); } catch {} });
});

// dirt delta flush: 7x/sec per room, only changed cells
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.changed.size) continue;
    const cells = [];
    for (const i of room.changed) cells.push([i, Math.round(room.grid[i] * 100) / 100]);
    room.changed.clear();
    broadcastRoom(room, { t: 'dirt', cells, remain: Math.round(room.remain * 10) / 10 });
  }
}, 150);

server.listen(PORT, () => {
  console.log('Clean Sweep co-op server on http://localhost:' + PORT);
  if (!process.env.ADMIN_KEY) console.log('ADMIN_KEY (troll console): ' + ADMIN_KEY);
});
