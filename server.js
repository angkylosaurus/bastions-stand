const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Explicit fallback for root — in case static middleware misses it
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Debug route to check what files exist
app.get('/debug', (req, res) => {
  const fs = require('fs');
  const publicPath = path.join(__dirname, 'public');
  let files = [];
  try { files = fs.readdirSync(publicPath); } catch(e) { files = ['ERROR: public folder not found - ' + e.message]; }
  const rootFiles = fs.readdirSync(__dirname);
  res.json({ rootFiles, publicFiles: files, publicPath });
});

const PORT = process.env.PORT || 3000;

// ─── PATH (same as client) ───
const PATH = [
  {x:0,y:70},{x:200,y:70},{x:280,y:50},{x:380,y:80},{x:500,y:60},{x:620,y:75},{x:750,y:55},{x:880,y:70},
  {x:920,y:110},
  {x:880,y:190},{x:750,y:175},{x:620,y:195},{x:500,y:180},{x:380,y:200},{x:280,y:185},{x:140,y:195},
  {x:60,y:230},
  {x:100,y:300},{x:220,y:290},{x:360,y:310},{x:480,y:295},{x:600,y:315},{x:720,y:300},{x:850,y:310},
  {x:910,y:360},
  {x:870,y:430},{x:740,y:420},{x:600,y:440},{x:480,y:425},{x:360,y:445},{x:220,y:430},{x:100,y:450},
  {x:60,y:490},{x:100,y:530},{x:200,y:520},{x:400,y:540},{x:600,y:525},{x:800,y:540},{x:960,y:530},
];
let PATH_LENGTHS = [0];
for (let i = 1; i < PATH.length; i++) {
  const dx = PATH[i].x - PATH[i-1].x, dy = PATH[i].y - PATH[i-1].y;
  PATH_LENGTHS.push(PATH_LENGTHS[i-1] + Math.sqrt(dx*dx+dy*dy));
}
const TOTAL_PATH_LEN = PATH_LENGTHS[PATH_LENGTHS.length-1];
const ZONE_BOUNDS = [0, 0.25, 0.5, 0.75, 1.0];

function posOnPath(t) {
  const d = t * TOTAL_PATH_LEN;
  for (let i = 1; i < PATH.length; i++) {
    if (PATH_LENGTHS[i] >= d) {
      const seg = PATH_LENGTHS[i] - PATH_LENGTHS[i-1];
      const f = seg > 0 ? (d - PATH_LENGTHS[i-1]) / seg : 0;
      return { x: PATH[i-1].x+(PATH[i].x-PATH[i-1].x)*f, y: PATH[i-1].y+(PATH[i].y-PATH[i-1].y)*f };
    }
  }
  return { x: PATH[PATH.length-1].x, y: PATH[PATH.length-1].y };
}
function zoneForT(t) {
  for (let i = 0; i < 4; i++) if (t >= ZONE_BOUNDS[i] && t < ZONE_BOUNDS[i+1]) return i;
  return 3;
}

// ─── TOWER & ENEMY DEFS ───
const TOWER_DEFS = [
  { id:'arrow', cost:50, range:90, fireRate:0.8, damage:8, aoe:0,
    upgrades: [
      { id:'rapid', cost:75, fireRate:0.4, damage:10, range:95, aoe:0 },
      { id:'multi', cost:75, fireRate:1.0, damage:7, range:90, aoe:0, multi:3 },
    ]},
  { id:'cannon', cost:100, range:80, fireRate:2.0, damage:25, aoe:35,
    upgrades: [
      { id:'mortar', cost:100, fireRate:2.2, damage:35, range:90, aoe:50 },
      { id:'siege', cost:120, fireRate:3.0, damage:60, range:85, aoe:30 },
    ]},
  { id:'magic', cost:75, range:100, fireRate:1.2, damage:12, aoe:0, slow:0.4,
    upgrades: [
      { id:'lightning', cost:100, fireRate:1.0, damage:18, range:110, aoe:0, slow:0.3, chain:3 },
      { id:'frost', cost:100, fireRate:1.4, damage:10, range:105, aoe:0, slow:0.6, freeze:0.15 },
    ]},
  { id:'sniper', cost:125, range:150, fireRate:3.0, damage:50, aoe:0,
    upgrades: [
      { id:'marks', cost:125, fireRate:2.8, damage:75, range:180, aoe:0 },
      { id:'assassin', cost:130, fireRate:2.5, damage:55, range:150, aoe:0, execute:0.15 },
    ]},
];

const ENEMY_TYPES = [
  { id:'basic', hp:40, speed:1.2, reward:10, radius:9 },
  { id:'fast', hp:20, speed:2.5, reward:12, radius:7 },
  { id:'tank', hp:120, speed:0.7, reward:25, radius:13 },
  { id:'flying', hp:50, speed:1.6, reward:20, radius:8, flying:true },
  { id:'boss', hp:500, speed:0.5, reward:100, radius:18 },
];

// ─── SPOTS ───
function generateSpots() {
  const spots = [];
  const spotsPerZone = 5;
  for (let z = 0; z < 4; z++) {
    const zStart = ZONE_BOUNDS[z], zEnd = ZONE_BOUNDS[z+1];
    for (let s = 0; s < spotsPerZone; s++) {
      const t = zStart + (zEnd-zStart) * (s+0.5) / spotsPerZone;
      const p = posOnPath(t);
      const t2 = Math.min(t+0.005, 1);
      const p2 = posOnPath(t2);
      const dx = p2.x-p.x, dy = p2.y-p.y;
      const len = Math.sqrt(dx*dx+dy*dy)||1;
      const nx = -dy/len, ny = dx/len;
      const side = (s%2===0)?1:-1;
      const off = 44 + (s%3)*10;
      spots.push({ x:Math.round(p.x+nx*off*side), y:Math.round(p.y+ny*off*side), zone:z, tower:null, id:spots.length });
    }
  }
  return spots;
}

// ─── ROOMS ───
const rooms = new Map();

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random()*chars.length)];
  return rooms.has(code) ? genRoomCode() : code;
}

function createRoom() {
  const code = genRoomCode();
  const room = {
    code,
    players: [{active:true,trait:null,gold:0,zone:0,ws:null,name:'Red Warden'},
              {active:false,trait:null,gold:0,zone:1,ws:null,name:'Blue Sentinel'},
              {active:false,trait:null,gold:0,zone:2,ws:null,name:'Green Ranger'},
              {active:false,trait:null,gold:0,zone:3,ws:null,name:'Gold Marshal'}],
    spots: generateSpots(),
    enemies: [],
    projectiles: [],
    lives: 20,
    wave: 0,
    maxWaves: 20,
    waveActive: false,
    state: 'lobby',
    gameLoop: null,
    events: [], // transient events to broadcast once
    nextEnemyId: 0,
  };
  rooms.set(code, room);
  return room;
}

function getPlayerSlot(room, ws) {
  return room.players.findIndex(p => p.ws === ws);
}

function getTowerStats(typeIdx, upgradeId, ownerIdx, room) {
  const def = TOWER_DEFS[typeIdx];
  let stats;
  if (upgradeId) {
    const upg = def.upgrades.find(u => u.id === upgradeId);
    stats = { fireRate:upg.fireRate, damage:upg.damage, range:upg.range, aoe:upg.aoe||0,
      slow:upg.slow||0, chain:upg.chain||0, freeze:upg.freeze||0, multi:upg.multi||0, execute:upg.execute||0 };
  } else {
    stats = { fireRate:def.fireRate, damage:def.damage, range:def.range, aoe:def.aoe||0,
      slow:def.slow||0, chain:0, freeze:0, multi:0, execute:0 };
  }
  const player = room.players[ownerIdx];
  if (player) {
    switch(player.trait) {
      case 'swift': stats.fireRate *= 0.7; break;
      case 'blast': stats.aoe *= 1.35; stats.range *= 1.05; break;
      case 'arcane': stats.range *= 1.30; break;
      case 'deadeye': stats.critChance = 0.20; break;
    }
  }
  return stats;
}

function generateWave(room) {
  const waveNum = room.wave;
  const enemies = [];
  const baseCount = 6 + waveNum * 2;
  const hpMult = 1 + waveNum * 0.25;
  const spdMult = 1 + waveNum * 0.02;
  const types = ['basic'];
  if (waveNum >= 2) types.push('fast');
  if (waveNum >= 4) types.push('tank');
  if (waveNum >= 6) types.push('flying');

  for (let i = 0; i < baseCount; i++) {
    const type = types[Math.floor(Math.random()*types.length)];
    const def = ENEMY_TYPES.find(e=>e.id===type);
    enemies.push({
      id: room.nextEnemyId++, type, hp:Math.round(def.hp*hpMult), maxHp:Math.round(def.hp*hpMult),
      speed:def.speed*spdMult, baseSpeed:def.speed*spdMult, reward:def.reward+Math.floor(waveNum/3),
      radius:def.radius, flying:def.flying||false, t:0, alive:true,
      slow:0, slowTimer:0, frozen:false, frozenTimer:0,
      spawnDelay:i*0.6, spawnTimer:0, spawned:false, midSpawn:false,
    });
  }
  if (waveNum > 0 && waveNum % 5 === 0) {
    const def = ENEMY_TYPES.find(e=>e.id==='boss');
    const bossHp = hpMult * (1 + Math.floor(waveNum/5)*0.5);
    enemies.push({
      id: room.nextEnemyId++, type:'boss', hp:Math.round(def.hp*bossHp), maxHp:Math.round(def.hp*bossHp),
      speed:def.speed*spdMult, baseSpeed:def.speed*spdMult, reward:def.reward+waveNum*2,
      radius:def.radius, flying:false, t:0, alive:true,
      slow:0, slowTimer:0, frozen:false, frozenTimer:0,
      spawnDelay:(baseCount+1)*0.6, spawnTimer:0, spawned:false, midSpawn:false,
    });
  }
  if (waveNum >= 10) {
    const extra = Math.floor(baseCount*0.3);
    for (let i = 0; i < extra; i++) {
      const type = types[Math.floor(Math.random()*types.length)];
      const def = ENEMY_TYPES.find(e=>e.id===type);
      enemies.push({
        id: room.nextEnemyId++, type, hp:Math.round(def.hp*hpMult), maxHp:Math.round(def.hp*hpMult),
        speed:def.speed*spdMult, baseSpeed:def.speed*spdMult, reward:def.reward+Math.floor(waveNum/3),
        radius:def.radius, flying:def.flying||false, t:0.5, alive:true,
        slow:0, slowTimer:0, frozen:false, frozenTimer:0,
        spawnDelay:i*0.7, spawnTimer:0, spawned:false, midSpawn:true,
      });
    }
  }
  return enemies;
}

// ─── GAME SIMULATION (runs on server at ~20fps) ───
const TICK_RATE = 50; // ms per tick
const BASE_SPEED = 0.000175; // 30% slower

function startGameLoop(room) {
  room.gameLoop = setInterval(() => tickRoom(room), TICK_RATE);
}
function stopGameLoop(room) {
  if (room.gameLoop) { clearInterval(room.gameLoop); room.gameLoop = null; }
}

function tickRoom(room) {
  if (room.state !== 'playing') return;
  const dt = TICK_RATE / 1000;
  room.events = [];

  // Update enemies
  for (const e of room.enemies) {
    if (!e.alive) continue;
    if (!e.spawned) {
      e.spawnTimer += dt;
      if (e.spawnTimer >= e.spawnDelay) e.spawned = true;
      else continue;
    }
    if (e.frozenTimer > 0) { e.frozenTimer -= dt; continue; }
    let spd = e.baseSpeed;
    if (e.slowTimer > 0) { spd *= (1 - e.slow); e.slowTimer -= dt; }
    e.t += BASE_SPEED * spd * dt * 60;
    if (e.t >= 1) {
      e.alive = false;
      room.lives--;
      room.events.push({ type:'leak', x: posOnPath(0.98).x, y: posOnPath(0.98).y });
      if (room.lives <= 0) {
        room.state = 'gameover';
        broadcastRoom(room, { type:'gameover', won:false, wave:room.wave });
        stopGameLoop(room);
        return;
      }
    }
  }

  // Update towers
  for (const spot of room.spots) {
    if (!spot.tower) continue;
    const t = spot.tower;
    t.fireTimer = (t.fireTimer || 0) - dt;
    if (t.fireTimer > 0) continue;

    let targets = [];
    for (const e of room.enemies) {
      if (!e.alive || !e.spawned || e.t < 0 || e.t >= 1) continue;
      const pos = posOnPath(e.t);
      const dx = pos.x - spot.x, dy = pos.y - spot.y;
      if (dx*dx+dy*dy <= t.range*t.range) targets.push({ enemy:e, pos, t_val:e.t });
    }
    if (targets.length === 0) continue;
    targets.sort((a,b) => b.t_val - a.t_val);
    t.fireTimer = t.fireRate;

    const num = t.multi || 1;
    for (let ti = 0; ti < Math.min(num, targets.length); ti++) {
      const tgt = targets[ti];
      dealDamage(room, spot, t, tgt.enemy);
    }
  }

  // Check wave complete
  if (room.waveActive) {
    const alive = room.enemies.filter(e => e.alive);
    if (alive.length === 0) {
      room.waveActive = false;
      room.enemies = [];
      if (room.wave >= room.maxWaves) {
        room.state = 'victory';
        broadcastRoom(room, { type:'gameover', won:true, wave:room.wave });
        stopGameLoop(room);
        return;
      }
    }
  }

  // Broadcast state
  broadcastState(room);
}

function dealDamage(room, spot, tower, enemy) {
  if (!enemy.alive) return;
  let dmg = tower.damage;
  let events = [];

  if (tower.critChance && Math.random() < tower.critChance) {
    dmg *= 2;
    const p = posOnPath(enemy.t);
    events.push({ type:'crit', x:p.x, y:p.y });
  }
  if (tower.execute && enemy.hp < enemy.maxHp*0.5 && Math.random() < tower.execute) {
    dmg = enemy.hp;
    const p = posOnPath(enemy.t);
    events.push({ type:'execute', x:p.x, y:p.y });
  }
  if (tower.aoe > 0) {
    const ep = posOnPath(enemy.t);
    for (const oe of room.enemies) {
      if (!oe.alive || oe === enemy || !oe.spawned || oe.t<0 || oe.t>=1) continue;
      const op = posOnPath(oe.t);
      if ((op.x-ep.x)**2+(op.y-ep.y)**2 <= tower.aoe*tower.aoe) {
        applyHit(room, oe, Math.round(dmg*0.6));
      }
    }
    events.push({ type:'aoe', x:ep.x, y:ep.y });
  }
  if (tower.chain > 0) {
    let chained = [enemy]; let last = enemy;
    for (let c = 0; c < tower.chain; c++) {
      let best = null, bestDist = 80*80;
      for (const oe of room.enemies) {
        if (!oe.alive || chained.includes(oe) || !oe.spawned || oe.t<0 || oe.t>=1) continue;
        const lp = posOnPath(last.t), op = posOnPath(oe.t);
        const dd = (op.x-lp.x)**2+(op.y-lp.y)**2;
        if (dd < bestDist) { best=oe; bestDist=dd; }
      }
      if (best) { chained.push(best); applyHit(room, best, Math.round(dmg*0.5)); last=best; }
    }
  }
  applyHit(room, enemy, dmg);
  if (tower.slow > 0) { enemy.slow = Math.max(enemy.slow, tower.slow); enemy.slowTimer = 2.0; }
  if (tower.freeze && Math.random() < tower.freeze) enemy.frozenTimer = 1.5;

  room.events.push({ type:'shot', sx:spot.x, sy:spot.y, tx:posOnPath(enemy.t).x, ty:posOnPath(enemy.t).y, towerType:tower.typeIdx });
  room.events.push(...events);
}

function applyHit(room, enemy, dmg) {
  enemy.hp -= dmg;
  if (enemy.hp <= 0 && enemy.alive) {
    enemy.alive = false;
    const zone = zoneForT(enemy.t);
    const owner = room.players.findIndex(p => p.active && p.zone === zone);
    if (owner >= 0) {
      room.players[owner].gold += enemy.reward;
      const p = posOnPath(enemy.t);
      room.events.push({ type:'gold', x:p.x, y:p.y, amount:enemy.reward, player:owner });
    }
    const p = posOnPath(enemy.t);
    room.events.push({ type:'kill', x:p.x, y:p.y, enemyType:enemy.type });
  }
}

function broadcastState(room) {
  const state = {
    type: 'state',
    lives: room.lives,
    wave: room.wave,
    waveActive: room.waveActive,
    maxWaves: room.maxWaves,
    players: room.players.map(p => ({ active:p.active, trait:p.trait, gold:p.gold, zone:p.zone, name:p.name })),
    enemies: room.enemies.filter(e=>e.alive&&e.spawned).map(e => ({
      id:e.id, type:e.type, t:e.t, hp:e.hp, maxHp:e.maxHp, radius:e.radius,
      flying:e.flying, slow:e.slowTimer>0, frozen:e.frozenTimer>0
    })),
    spots: room.spots.map(s => ({
      x:s.x, y:s.y, zone:s.zone, id:s.id,
      tower: s.tower ? { typeIdx:s.tower.typeIdx, upgraded:s.tower.upgraded, owner:s.tower.owner, range:s.tower.range } : null,
    })),
    events: room.events,
  };
  const msg = JSON.stringify(state);
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(msg);
  }
}

function broadcastRoom(room, data) {
  const msg = JSON.stringify(data);
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(msg);
  }
}

function broadcastLobby(room) {
  const data = {
    type: 'lobby',
    code: room.code,
    players: room.players.map(p => ({ active:p.active, trait:p.trait, name:p.name, connected: !!p.ws })),
  };
  const msg = JSON.stringify(data);
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(msg);
  }
}

// ─── WEBSOCKET HANDLING ───
wss.on('connection', (ws) => {
  ws._room = null;
  ws._slot = -1;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create': {
        const room = createRoom();
        room.players[0].ws = ws;
        room.players[0].active = true;
        ws._room = room;
        ws._slot = 0;
        ws.send(JSON.stringify({ type:'joined', code:room.code, slot:0 }));
        broadcastLobby(room);
        break;
      }
      case 'join': {
        const room = rooms.get((msg.code||'').toUpperCase());
        if (!room) { ws.send(JSON.stringify({ type:'error', msg:'Room not found' })); break; }
        if (room.state !== 'lobby') { ws.send(JSON.stringify({ type:'error', msg:'Game already started' })); break; }
        const slot = room.players.findIndex(p => !p.ws && !p.active);
        const emptySlot = slot >= 0 ? slot : room.players.findIndex(p => !p.ws);
        if (emptySlot < 0) { ws.send(JSON.stringify({ type:'error', msg:'Room full' })); break; }
        room.players[emptySlot].ws = ws;
        room.players[emptySlot].active = true;
        ws._room = room;
        ws._slot = emptySlot;
        ws.send(JSON.stringify({ type:'joined', code:room.code, slot:emptySlot }));
        broadcastLobby(room);
        break;
      }
      case 'selectTrait': {
        const room = ws._room;
        if (!room || room.state !== 'lobby') break;
        const slot = ws._slot;
        const taken = room.players.filter((_,i)=>i!==slot&&_.trait).map(p=>p.trait);
        if (taken.includes(msg.trait)) break;
        room.players[slot].trait = msg.trait;
        broadcastLobby(room);
        break;
      }
      case 'startGame': {
        const room = ws._room;
        if (!room || room.state !== 'lobby') break;
        const active = room.players.filter(p=>p.active);
        if (active.length < 1 || !active.every(p=>p.trait)) break;
        const startGold = Math.round(200/active.length) + 50;
        active.forEach(p => p.gold = startGold);
        room.state = 'playing';
        room.spots = generateSpots();
        broadcastRoom(room, { type:'gameStart' });
        startGameLoop(room);
        break;
      }
      case 'sendWave': {
        const room = ws._room;
        if (!room || room.state !== 'playing' || room.waveActive) break;
        room.wave++;
        room.waveActive = true;
        room.enemies = generateWave(room);
        break;
      }
      case 'placeTower': {
        const room = ws._room;
        if (!room || room.state !== 'playing') break;
        const slot = ws._slot;
        const player = room.players[slot];
        const spot = room.spots.find(s => s.id === msg.spotId);
        if (!spot || spot.tower || spot.zone !== player.zone) break;
        const def = TOWER_DEFS[msg.towerType];
        if (!def || player.gold < def.cost) break;
        player.gold -= def.cost;
        spot.tower = { typeIdx:msg.towerType, upgraded:null, fireTimer:0, owner:slot,
          ...getTowerStats(msg.towerType, null, slot, room) };
        break;
      }
      case 'upgradeTower': {
        const room = ws._room;
        if (!room || room.state !== 'playing') break;
        const slot = ws._slot;
        const spot = room.spots.find(s => s.id === msg.spotId);
        if (!spot || !spot.tower || spot.tower.owner !== slot || spot.tower.upgraded) break;
        const def = TOWER_DEFS[spot.tower.typeIdx];
        const upg = def.upgrades.find(u => u.id === msg.upgradeId);
        if (!upg || room.players[slot].gold < upg.cost) break;
        room.players[slot].gold -= upg.cost;
        spot.tower.upgraded = msg.upgradeId;
        Object.assign(spot.tower, getTowerStats(spot.tower.typeIdx, msg.upgradeId, slot, room));
        break;
      }
      case 'sellTower': {
        const room = ws._room;
        if (!room || room.state !== 'playing') break;
        const slot = ws._slot;
        const spot = room.spots.find(s => s.id === msg.spotId);
        if (!spot || !spot.tower || spot.tower.owner !== slot) break;
        const def = TOWER_DEFS[spot.tower.typeIdx];
        const upgCost = spot.tower.upgraded ? def.upgrades.find(u=>u.id===spot.tower.upgraded).cost : 0;
        room.players[slot].gold += Math.round((def.cost + upgCost) * 0.6);
        spot.tower = null;
        break;
      }
      case 'trade': {
        const room = ws._room;
        if (!room || room.state !== 'playing') break;
        const from = ws._slot;
        const to = msg.to;
        const amt = msg.amount;
        if (to < 0 || to >= 4 || to === from || !room.players[to].active) break;
        if (!Number.isInteger(amt) || amt < 1 || amt > room.players[from].gold) break;
        room.players[from].gold -= amt;
        room.players[to].gold += amt;
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = ws._room;
    if (!room) return;
    const slot = ws._slot;
    if (slot >= 0) {
      room.players[slot].ws = null;
      if (room.state === 'lobby') {
        room.players[slot].active = false;
        room.players[slot].trait = null;
        broadcastLobby(room);
      }
    }
    // Clean up empty rooms
    if (room.players.every(p => !p.ws)) {
      stopGameLoop(room);
      rooms.delete(room.code);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Bastion's Stand server running on port ${PORT}`);
});
