const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

let players = {};
let passengers = [];
let nextPassengerId = 1;

const PICKUP_WINDOW_MS = 23000;    // how long a waiting passenger stays on the road
const CANCEL_COOLDOWN_MS = 20000;
const MIN_PLAYERS = 2;             // the host can't start a match with fewer drivers than this

// ---- scaling: more drivers = more passengers, spawning faster ----
const playerCount = () => Object.keys(players).length;
const maxWaiting = () => Math.max(6, playerCount() * 2);                         // passengers allowed on the road at once
const spawnDelayMs = () => Math.max(1200, Math.round(24000 / Math.max(1, playerCount())));  // 4 drivers: 6s, 8: 3s, 12: 2s (floor 1.2s)

// Put a carried passenger back on the road with the time they had left at pickup
function releasePassenger(p, x, z, byId) {
  p.pickedUpBy = null;
  p.x = x; p.z = z;
  p.spawnTime = Date.now() - (PICKUP_WINDOW_MS - (p.remainingMs ?? PICKUP_WINDOW_MS));
  p.blockedId = byId;                       // the driver who dropped them can't instantly re-grab
  p.blockedUntil = Date.now() + 5000;
}

const LANDMARKS = require('./public/landmarks.js');           // shared with the controller
const { resolveCollision } = require('./public/carstats.js');   // shared physics

// ---- match state: 'lobby' (waiting for host) -> 'countdown' (3-2-1-GO) -> 'playing' -> 'ended' (results) -> back to 'lobby' ----
const game = { state: 'lobby', endsAt: 0, minutes: 4, timer: null, lastResults: null, cdTimers: [] };
const gameInfo = () => ({
  minPlayers: MIN_PLAYERS, state: game.state, minutes: game.minutes,
  remainingMs: game.state === 'playing' ? Math.max(0, game.endsAt - Date.now()) : game.state === 'countdown' ? game.minutes * 60000 : 0
});


// each driver starts on a different open intersection so nobody spawns on top of anyone
const SPAWNS = [[45, 45], [-45, 45], [45, -45], [-45, -45], [135, 45], [-135, 45], [135, -45], [-135, -45],
                [225, 45], [-225, 45], [225, -45], [-225, -45], [45, 135], [-45, 135], [135, 135], [-135, 135]];   // all road intersections
const newStats = () => ({ trips: 0, cancels: 0, spinsTaken: 0, spinsDealt: 0, wallCrashes: 0 });

// "Driver 1", "Driver 2", ... lowest free number; custom names can't repeat ("Sam", "Sam 2", ...)
function uniqueName(requested) {
  const taken = new Set(Object.values(players).map(p => p.name.toLowerCase()));
  const name = String(requested || '').trim().slice(0, 12);
  if (!name || /^driver \d+$/i.test(name)) { let n = 1; while (taken.has('driver ' + n)) n++; return 'Driver ' + n; }
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) { const tail = ' ' + n, cand = name.slice(0, 12 - tail.length) + tail; if (!taken.has(cand.toLowerCase())) return cand; }
}

// titles handed out when the match ends
const AWARDS = [
  ['trips',       'TAXI TITAN',       'rides'],
  ['spinsDealt',  'DEMOLITION DERBY', 'spin-outs caused'],
  ['spinsTaken',  'SPINNING TOP',     'spin-outs suffered'],
  ['wallCrashes', 'WALL HUGGER',      'wall crashes'],
  ['cancels',     'GHOSTER',          'cancelled rides']
];
function buildResults() {
  const list = Object.values(players);
  const ranking = list.map(p => ({ name: p.name, tips: p.tips, carClass: p.carClass })).sort((a, b) => b.tips - a.tips);
  const awards = [];
  AWARDS.forEach(([key, title, unit]) => {
    let best = null;
    list.forEach(p => { if (p.stats[key] > 0 && (!best || p.stats[key] > best.stats[key])) best = p; });
    if (best) awards.push({ title, name: best.name, detail: best.stats[key] + ' ' + unit });
  });
  return { winner: ranking[0] || null, ranking, awards };
}
const GRID = [-270, -180, -90, 0, 90, 180, 270];
const landmarkKeys = new Set(LANDMARKS.map(l => l.x + ',' + l.z));
// block centres that don't have a landmark on them = safe pickup spots
const freeBlocks = [];
GRID.forEach(x => GRID.forEach(z => { if (!landmarkKeys.has(x + ',' + z)) freeBlocks.push({ x, z }); }));

// Spawn passengers on landmark-free blocks, only while a match is running
function spawnPassenger() {
  {
    const sizes = [1, 2, 3, 4];
    const size = sizes[Math.floor(Math.random() * sizes.length)];
    
    const spot = freeBlocks[Math.floor(Math.random() * freeBlocks.length)];
    const x = spot.x, z = spot.z;
    const dest = LANDMARKS[Math.floor(Math.random() * LANDMARKS.length)];
    const destX = dest.x, destZ = dest.z, randomDestName = dest.name;
    let baseTip = size * 25;

    passengers.push({
      id: nextPassengerId++,
      x: x, z: z,
      destX: destX, destZ: destZ,
      destName: randomDestName,
      size: size,
      tipValue: baseTip,
      spawnTime: Date.now(),
      pickedUpBy: null
    });
    
    io.emit('sync-passengers', passengers);
  }
}
// self-rescheduling so the spawn rate follows the current player count
function spawnLoop() {
  if (game.state === 'playing' && passengers.filter(p => !p.pickedUpBy).length < maxWaiting()) spawnPassenger();
  setTimeout(spawnLoop, spawnDelayMs());
}
spawnLoop();

const COUNTDOWN_STEPS = [3, 2, 1, 0];     // seconds shown; 0 = GO
function beginCountdown(minutes) {
  game.state = 'countdown'; game.minutes = minutes; game.lastResults = null; passengers = [];
  Object.values(players).forEach(p => { p.tips = 100; p.stats = newStats(); p.speed = 0; [p.posX, p.posZ] = SPAWNS[p.spawnIndex % SPAWNS.length]; });   // everyone is placed on the road, frozen
  io.emit('sync-passengers', passengers);
  io.emit('game-countdown', { minutes });
  io.emit('game-info', gameInfo());
  broadcastLeaderboard();
  game.cdTimers.forEach(clearTimeout);
  game.cdTimers = COUNTDOWN_STEPS.map((n, i) => setTimeout(() => {
    io.emit('countdown-tick', { n });
    if (n === 0) startGame(minutes);
  }, 600 + i * 1000));
}
function cancelCountdown() {
  game.cdTimers.forEach(clearTimeout); game.cdTimers = [];
  resetToLobby();
}
function startGame(minutes) {
  game.state = 'playing'; game.minutes = minutes; game.endsAt = Date.now() + minutes * 60000; game.lastResults = null;
  passengers = [];
  Object.values(players).forEach((p, i) => { p.tips = 100; p.stats = newStats(); p.speed = 0; [p.posX, p.posZ] = SPAWNS[p.spawnIndex % SPAWNS.length]; });
  for (let i = 0, n = Math.max(3, playerCount()); i < n; i++) spawnPassenger();   // get the action going right away (one per driver)
  io.emit('sync-passengers', passengers);
  io.emit('game-started', { remainingMs: minutes * 60000, minutes });
  io.emit('game-info', gameInfo());
  broadcastLeaderboard();
  clearTimeout(game.timer); game.timer = setTimeout(endGame, minutes * 60000);
}
function endGame() {
  if (game.state !== 'playing') return;
  clearTimeout(game.timer);
  game.state = 'ended'; passengers = [];
  game.lastResults = buildResults();
  io.emit('sync-passengers', passengers);
  io.emit('game-ended', game.lastResults);
  io.emit('game-info', gameInfo());
}
function resetToLobby() {
  game.state = 'lobby'; game.lastResults = null; passengers = [];
  Object.values(players).forEach(p => { p.tips = 100; p.stats = newStats(); p.speed = 0; [p.posX, p.posZ] = SPAWNS[p.spawnIndex % SPAWNS.length]; });
  io.emit('sync-passengers', passengers);
  io.emit('game-reset');
  io.emit('game-info', gameInfo());
  broadcastLeaderboard();
}

setInterval(() => {
  const now = Date.now();
  const prevLength = passengers.length;
  passengers = passengers.filter(p => p.pickedUpBy || (now - p.spawnTime < PICKUP_WINDOW_MS));
  
  if (passengers.length !== prevLength) {
    io.emit('sync-passengers', passengers);
  }
}, 1000);

function broadcastLeaderboard() {
  const leaderboardData = Object.values(players).map(p => ({
    name: p.name,
    tips: p.tips,
    carClass: p.carClass
  })).sort((a, b) => b.tips - a.tips);

  io.emit('update-leaderboard', leaderboardData);
}

// ---- car vs car collisions: checked 20x/sec from the positions + speeds each driver reports ----
const hitCooldown = {};   // pair -> time when they can collide again
setInterval(() => {
  if (game.state !== 'playing') return;
  const ids = Object.keys(players), now = Date.now();
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const key = [ids[i], ids[j]].sort().join('|');
    if ((hitCooldown[key] || 0) > now) continue;
    const hit = resolveCollision(players[ids[i]], players[ids[j]]);
    if (!hit) continue;
    hitCooldown[key] = now + 1200;
    if (hit.a.spin) { players[ids[i]].stats.spinsTaken++; players[ids[j]].stats.spinsDealt++; }
    if (hit.b.spin) { players[ids[j]].stats.spinsTaken++; players[ids[i]].stats.spinsDealt++; }
    io.to(ids[i]).emit('car-hit', hit.a);
    io.to(ids[j]).emit('car-hit', hit.b);
  }
}, 50);

io.on('connection', (socket) => {
  // ---- host screen ----
  socket.on('host-join', () => {
    socket.isHost = true; 
    socket.emit('sync-players', players);
    socket.emit('game-info', gameInfo());
    if (game.state === 'ended' && game.lastResults) socket.emit('game-ended', game.lastResults);
    broadcastLeaderboard();
  });
  socket.on('host-start', (data) => {
    if (!socket.isHost || game.state !== 'lobby' || playerCount() < MIN_PLAYERS) return;
    beginCountdown(Math.max(1, Math.min(10, Math.round(Number(data && data.minutes)) || 4)));
  });
  socket.on('host-reset', () => { if (socket.isHost && game.state === 'ended') resetToLobby(); });

  // ---- drivers ----
  socket.on('join-game', (data) => {
    if (players[socket.id]) return;
    const used = new Set(Object.values(players).map(p => p.spawnIndex));
    let spawnIndex = 0; while (used.has(spawnIndex)) spawnIndex++;
    const [sx, sz] = SPAWNS[spawnIndex % SPAWNS.length];
    players[socket.id] = {
      playerId: socket.id,
      name: uniqueName(data.name),
      carClass: ['Small', 'Large', 'Luxury'].includes(data.carClass) ? data.carClass : 'Small',
      tips: 100, stats: newStats(), spawnIndex,
      posX: sx, posZ: sz, rotationAngle: 0, accelerating: false, speed: 0
    };

    socket.emit('assigned-player', { playerId: socket.id, name: players[socket.id].name, spawnX: sx, spawnZ: sz });
    io.emit('sync-players', players);
    socket.emit('sync-passengers', passengers);
    socket.emit('game-info', gameInfo());
    if (game.state === 'countdown') socket.emit('game-countdown', { minutes: game.minutes });
    if (game.state === 'playing') socket.emit('game-started', { remainingMs: gameInfo().remainingMs, minutes: game.minutes });   // joining mid-match: straight in
    broadcastLeaderboard();
  });

  socket.on('steering-input', (data) => {
    if (players[socket.id]) {
      players[socket.id].posX = data.posX;
      players[socket.id].posZ = data.posZ;
      players[socket.id].rotationAngle = data.rotationAngle;
      players[socket.id].accelerating = data.accelerating;
      players[socket.id].speed = data.speed || 0;
      socket.broadcast.emit('update-car-state', data);
    }
  });

  socket.on('claim-passenger', (data) => {
    if (game.state !== 'playing') return;
    const { passengerId, carClass } = data;
    const passenger = passengers.find(p => p.id === passengerId);

    const alreadyCarrying = passengers.some(q => q.pickedUpBy === socket.id);
    const blocked = passenger && passenger.blockedId === socket.id && Date.now() < passenger.blockedUntil;
    if (passenger && !passenger.pickedUpBy && !alreadyCarrying && !blocked) {
      let maxCap = (carClass === 'Small') ? 2 : (carClass === 'Large' ? 4 : 1);
      if (passenger.size <= maxCap) {
        passenger.pickedUpBy = socket.id;
        passenger.remainingMs = Math.max(0, PICKUP_WINDOW_MS - (Date.now() - passenger.spawnTime));
        io.emit('sync-passengers', passengers);
        socket.emit('passenger-picked-up', passenger);
      }
    }
  });

  socket.on('complete-trip', (data) => {
    if (game.state !== 'playing') return;
    const { passengerId, carClass } = data;
    const pIndex = passengers.findIndex(p => p.id === passengerId);

    if (pIndex !== -1 && passengers[pIndex].pickedUpBy === socket.id) {
      const passenger = passengers[pIndex];
      passengers.splice(pIndex, 1);
      io.emit('sync-passengers', passengers);

      let finalTip = carClass === 'Luxury' ? 150 : passenger.tipValue;
      if (players[socket.id]) {
        players[socket.id].tips += finalTip;
        players[socket.id].stats.trips++;
        broadcastLeaderboard();
      }

      socket.emit('trip-completed', { tip: finalTip });
    }
  });

  // Cancel: no money, passenger goes back where the car is, 20s cooldown, only while carrying
  socket.on('cancel-ride', () => {
    const me = players[socket.id];
    if (!me || game.state !== 'playing') return;
    const now = Date.now();
    if (now - (me.lastCancel || 0) < CANCEL_COOLDOWN_MS) return;
    const p = passengers.find(q => q.pickedUpBy === socket.id);
    if (!p) return;
    me.lastCancel = now;
    me.stats.cancels++;
    releasePassenger(p, me.posX, me.posZ, socket.id);
    io.emit('sync-passengers', passengers);
    socket.emit('ride-cancelled');
  });

  socket.on('wall-crash', () => {   // reported by the driver's phone; counted for the WALL HUGGER title
    const me = players[socket.id], now = Date.now();
    if (!me || game.state !== 'playing' || now - (me.lastWall || 0) < 1000) return;
    me.lastWall = now; me.stats.wallCrashes++;
  });

  socket.on('disconnect', () => {
    const gone = players[socket.id];
    passengers.forEach(p => { if (p.pickedUpBy === socket.id) releasePassenger(p, gone ? gone.posX : p.x, gone ? gone.posZ : p.z, null); });
    io.emit('sync-passengers', passengers);
    delete players[socket.id];
    io.emit('player-left', { playerId: socket.id });
    broadcastLeaderboard();
    if (game.state === 'countdown' && playerCount() < MIN_PLAYERS) cancelCountdown();   // fell below the minimum before GO
  });
});

server.listen(3000, () => {
  console.log('UberRacer server running on http://localhost:3000');
});