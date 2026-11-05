const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_PER_ROOM = 12;
const TICK_MS = 1000 / 15;
const MAX_HIT_RANGE = 90;
const MAX_DAMAGE = 85;
const HITS_PER_SECOND = 40;
const FIRE_MIN_GAP_MS = 70;
const FIRE_WEAPONS = new Set(['popper', 'leafblower', 'cauli', 'brussels', 'sniper']);
const ARENA_LIMIT = 70;

const app = express();
app.get('/healthz', (_req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

// roomCode -> { code, players: Map<socketId, player> }
const rooms = new Map();

function cleanName(s) {
  return String(s || '').replace(/[^\w \-]/g, '').trim().slice(0, 16) || 'Muncher';
}

function pub(p) {
  return { id: p.id, name: p.name, x: p.x, z: p.z, dx: p.dx, dz: p.dz, alive: p.alive, health: p.health };
}

function getRoom(privateCode) {
  if (privateCode) {
    const code = 'PRV-' + privateCode;
    if (!rooms.has(code)) rooms.set(code, { code, players: new Map() });
    return rooms.get(code);
  }
  for (const r of rooms.values()) {
    if (r.code.startsWith('PUB-') && r.players.size < MAX_PER_ROOM) return r;
  }
  const code = 'PUB-' + Math.random().toString(36).slice(2, 7).toUpperCase();
  const r = { code, players: new Map() };
  rooms.set(code, r);
  return r;
}

io.on('connection', (socket) => {
  let room = null;
  let player = null;
  let lastFireMs = 0;
  let hitWindowStart = 0;
  let hitCount = 0;

  socket.on('join', (data, ack) => {
    if (typeof ack !== 'function') return;
    if (room) return ack({ ok: false, error: 'already joined' });

    const wanted = data && data.room ? String(data.room).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) : '';
    if (data && data.room && !wanted) return ack({ ok: false, error: 'invalid room code' });

    const r = getRoom(wanted || null);
    if (r.players.size >= MAX_PER_ROOM) return ack({ ok: false, error: 'room is full' });

    room = r;
    player = {
      id: socket.id, name: cleanName(data && data.name),
      x: 0, z: 0, dx: 0, dz: 1,
      alive: true, health: 100, kills: 0, deaths: 0, spawned: false
    };
    r.players.set(socket.id, player);
    socket.join(r.code);
    socket.to(r.code).emit('player:join', pub(player));

    ack({
      ok: true,
      id: socket.id,
      room: r.code.replace(/^(PUB|PRV)-/, ''),
      players: [...r.players.values()].filter(p => p.id !== socket.id).map(pub)
    });
  });

  socket.on('move', (m) => {
    if (!player || !m) return;
    const vals = [m.x, m.z, m.dx, m.dz].map(Number);
    if (!vals.every(Number.isFinite)) return;
    player.x = Math.max(-ARENA_LIMIT, Math.min(ARENA_LIMIT, vals[0]));
    player.z = Math.max(-ARENA_LIMIT, Math.min(ARENA_LIMIT, vals[1]));
    player.dx = vals[2];
    player.dz = vals[3];
  });

  socket.on('fire', (f) => {
    if (!room || !player || !player.alive || !f) return;
    const now = Date.now();
    if (now - lastFireMs < FIRE_MIN_GAP_MS) return;
    if (!FIRE_WEAPONS.has(f.weapon)) return;
    const o = Array.isArray(f.o) && f.o.length === 3 ? f.o.map(Number) : null;
    const d = Array.isArray(f.d) && f.d.length === 3 ? f.d.map(Number) : null;
    if (!o || !d || ![...o, ...d].every(Number.isFinite)) return;
    lastFireMs = now;
    socket.to(room.code).emit('shots', { ownerId: socket.id, weapon: f.weapon, o, d });
  });

  // Clients detect their own hits against the rendered arena and report them.
  // The server checks range, rate and victim state, then owns health and kills.
  socket.on('hit', (h) => {
    if (!room || !player || !player.alive || !h) return;
    const sec = Date.now() / 1000;
    if (sec - hitWindowStart >= 1) { hitWindowStart = sec; hitCount = 0; }
    if (++hitCount > HITS_PER_SECOND) return;

    const victim = room.players.get(h.victimId);
    if (!victim || victim === player || !victim.alive) return;
    const dmg = Math.min(MAX_DAMAGE, Math.max(1, Number(h.damage) || 0));
    if (!Number.isFinite(dmg)) return;
    if (Math.hypot(victim.x - player.x, victim.z - player.z) > MAX_HIT_RANGE) return;

    victim.health = Math.max(0, victim.health - dmg);
    io.to(room.code).emit('health', { id: victim.id, health: victim.health });

    if (victim.health <= 0) {
      victim.alive = false;
      victim.deaths++;
      player.kills++;
      io.to(room.code).emit('kill', {
        killerId: player.id, killerName: player.name,
        victimId: victim.id, victimName: victim.name
      });
    }
  });

  socket.on('respawn', (r) => {
    if (!room || !player || !r) return;
    if (player.alive && player.spawned) return;
    const x = Number(r.x), z = Number(r.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    player.x = Math.max(-ARENA_LIMIT, Math.min(ARENA_LIMIT, x));
    player.z = Math.max(-ARENA_LIMIT, Math.min(ARENA_LIMIT, z));
    player.alive = true;
    player.health = 100;
    player.spawned = true;
    io.to(room.code).emit('respawn', { id: socket.id, x: player.x, z: player.z });
  });

  socket.on('disconnect', () => {
    if (!room) return;
    room.players.delete(socket.id);
    io.to(room.code).emit('player:leave', { id: socket.id });
    if (room.players.size === 0) rooms.delete(room.code);
  });
});

// Position broadcast at 15 Hz. Clients interpolate between updates.
setInterval(() => {
  for (const r of rooms.values()) {
    if (r.players.size < 2) continue;
    const list = [...r.players.values()].map(p => ({ id: p.id, x: p.x, z: p.z, dx: p.dx, dz: p.dz }));
    io.to(r.code).emit('moves', list);
  }
}, TICK_MS);

server.listen(PORT, () => console.log('CabbageMuncher online server on port ' + PORT));
