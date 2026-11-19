/* Shardfield simulation — shared by the browser client and the Node server.
   Pure and deterministic: all state is one plain JSON "world" object that only
   changes through step(world, inputs, dt). Randomness comes from a seeded RNG
   stored in the world. No DOM or network access here. */
(function (root, factory) {
  const Sim = factory();
  if (typeof module === "object" && module.exports) module.exports = Sim;
  else root.Sim = Sim;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const CFG = {
    W: 1280, H: 800, TICK: 1 / 60,
    MAX_PLAYERS: 6, LIVES: 3, EXTRA_LIFE_EVERY: 10000,
    SHIP_R: 13, TURN: 4.4, THRUST: 430, DRAG: 0.55, MAX_SPEED: 540,
    BULLET_SPEED: 700, BULLET_LIFE: 0.95, FIRE_COOLDOWN: 0.2, MAX_BULLETS: 5,
    RESPAWN_DELAY: 1.6, INVULN: 2.6, SAFE_SPAWN: 140,
    ROCKS: { 3: { r: 50, score: 20, vmin: 28, vmax: 70 },
             2: { r: 27, score: 50, vmin: 50, vmax: 115 },
             1: { r: 14, score: 100, vmin: 80, vmax: 160 } },
    START_ROCKS: 4, MAX_ROCKS_WAVE: 12,
    ROUND_PAUSE: 2.4, GAMEOVER_PAUSE: 4.5,
    FRIENDLY_FIRE: false,
    // Easter egg: these pilots fire twice as fast (names compared case-insensitively).
    RAPID_FIRE_NAMES: ["MRMANGE"],
  };
  const IN = { THRUST: 1, LEFT: 2, RIGHT: 4, FIRE: 8 };
  const COLORS = ["#ffb547", "#7fd8ff", "#ff7aa8", "#a6f08a", "#c9a6ff", "#ffe36e"];

  function mulberry(seed) {
    let s = seed >>> 0;
    return () => {
      let t = (s = (s + 0x6D2B79F5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // RNG state lives in world.rng so the sim stays reproducible
  function rnd(w) {
    let t = (w.rng = (w.rng + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const range = (w, a, b) => a + (b - a) * rnd(w);

  // Rock outlines are derived from the rock id, so they never travel over the network.
  const shapeCache = new Map();
  function rockShape(id) {
    let s = shapeCache.get(id);
    if (!s) {
      const r = mulberry(Math.imul(id, 2654435761));
      const n = 9 + Math.floor(r() * 4);
      s = [];
      for (let i = 0; i < n; i++) s.push(0.72 + r() * 0.36);
      if (shapeCache.size > 2000) shapeCache.clear();
      shapeCache.set(id, s);
    }
    return s;
  }

  const wrapD = (d, s) => (d > s / 2 ? d - s : d < -s / 2 ? d + s : d);
  const dist2 = (a, b) => {
    const dx = wrapD(b.x - a.x, CFG.W), dy = wrapD(b.y - a.y, CFG.H);
    return dx * dx + dy * dy;
  };
  const wrapXY = (x, y) => [((x % CFG.W) + CFG.W) % CFG.W, ((y % CFG.H) + CFG.H) % CFG.H];
  const wrap = (o) => { [o.x, o.y] = wrapXY(o.x, o.y); };

  function createWorld(seed = (Math.random() * 2 ** 32) >>> 0) {
    return {
      v: 2, tick: 0, rng: seed >>> 0, nextId: 1,
      phase: "playing", phaseT: 0, round: 0,
      players: {}, rocks: [], bullets: [],
    };
  }

  function addPlayer(w, id, name) {
    if (w.players[id] || Object.keys(w.players).length >= CFG.MAX_PLAYERS) return null;
    const used = new Set(Object.values(w.players).map((p) => p.slot));
    let slot = 0; while (used.has(slot)) slot++;
    const p = {
      id, name: name || `P${slot + 1}`, slot, color: COLORS[slot],
      score: 0, lives: CFG.LIVES, nextLifeAt: CFG.EXTRA_LIFE_EVERY,
      fireRate: CFG.RAPID_FIRE_NAMES.includes(String(name || "").toUpperCase()) ? 2 : 1,
      ship: { x: 0, y: 0, vx: 0, vy: 0, a: -Math.PI / 2, alive: false,
              respawnT: 0, invulnT: 0, cooldown: 0, thrusting: false },
    };
    w.players[id] = p;
    // A player joining after game over waits for the next match like everyone else.
    if (w.phase !== "gameover") trySpawn(w, p, true);
    return p;
  }
  function removePlayer(w, id) {
    delete w.players[id];
    w.bullets = w.bullets.filter((b) => b.owner !== id);
  }

  function spawnPoint(w, p) {
    const n = Math.max(1, Object.keys(w.players).length);
    if (n === 1) return { x: CFG.W / 2, y: CFG.H / 2 };
    const ang = (p.slot / CFG.MAX_PLAYERS) * Math.PI * 2 - Math.PI / 2;
    return { x: CFG.W / 2 + Math.cos(ang) * 170, y: CFG.H / 2 + Math.sin(ang) * 130 };
  }

  function trySpawn(w, p, force) {
    const sp = spawnPoint(w, p);
    if (!force && w.rocks.some((r) => dist2(r, sp) < (r.r + CFG.SAFE_SPAWN) ** 2)) return false;
    Object.assign(p.ship, { x: sp.x, y: sp.y, vx: 0, vy: 0, a: -Math.PI / 2, alive: true,
      invulnT: CFG.INVULN, cooldown: 0.3, thrusting: false });
    return true;
  }

  const speedMul = (w) => 1 + Math.min(0.6, (w.round - 1) * 0.06);

  function makeRock(w, size, x, y, mul = 1) {
    const def = CFG.ROCKS[size];
    const dir = rnd(w) * Math.PI * 2, sp = range(w, def.vmin, def.vmax) * mul;
    return { id: w.nextId++, size, r: def.r, x, y,
      vx: Math.cos(dir) * sp, vy: Math.sin(dir) * sp,
      a: rnd(w) * Math.PI * 2, spin: range(w, -1.2, 1.2) };
  }

  function startRound(w, events) {
    w.round++;
    w.phase = "playing"; w.phaseT = 0; w.bullets = [];
    const nPlayers = Object.keys(w.players).length;
    const count = Math.min(CFG.MAX_ROCKS_WAVE, CFG.START_ROCKS + (w.round - 1) + Math.max(0, nPlayers - 1));
    const ships = Object.values(w.players).map((p) => (p.ship.alive ? p.ship : spawnPoint(w, p)));
    for (let i = 0; i < count; i++) {
      let x, y, tries = 0;
      do { // spawn on the rim, away from every ship
        const edge = rnd(w) < 0.5;
        x = edge ? range(w, 0, CFG.W) : (rnd(w) < 0.5 ? 0 : CFG.W - 1);
        y = edge ? (rnd(w) < 0.5 ? 0 : CFG.H - 1) : range(w, 0, CFG.H);
      } while (++tries < 20 && ships.some((s) => dist2(s, { x, y }) < 260 * 260));
      w.rocks.push(makeRock(w, 3, x, y, speedMul(w)));
    }
    for (const p of Object.values(w.players)) if (p.ship.alive) p.ship.invulnT = Math.max(p.ship.invulnT, 1.2);
    events.push({ type: "round", round: w.round });
  }

  function resetMatch(w, events) {
    w.rocks = []; w.bullets = []; w.round = 0;
    for (const p of Object.values(w.players)) {
      p.score = 0; p.lives = CFG.LIVES; p.nextLifeAt = CFG.EXTRA_LIFE_EVERY;
      trySpawn(w, p, true);
    }
    startRound(w, events);
  }

  function killShip(w, p, events) {
    const s = p.ship;
    s.alive = false; s.respawnT = CFG.RESPAWN_DELAY; s.thrusting = false;
    p.lives--;
    // final: this was the player's last ship, so their score for this match is settled
    events.push({ type: "shipDie", x: s.x, y: s.y, vx: s.vx, vy: s.vy, color: p.color, id: p.id,
      final: p.lives <= 0, score: p.score, round: w.round, name: p.name });
  }

  function addScore(w, p, pts, events) {
    p.score += pts;
    while (p.score >= p.nextLifeAt) {
      p.lives++; p.nextLifeAt += CFG.EXTRA_LIFE_EVERY;
      events.push({ type: "extraLife", id: p.id });
    }
  }

  function breakRock(w, idx, owner, events) {
    const r = w.rocks[idx];
    w.rocks.splice(idx, 1);
    if (owner) addScore(w, owner, CFG.ROCKS[r.size].score, events);
    events.push({ type: "rockBreak", x: r.x, y: r.y, size: r.size });
    if (r.size > 1) {
      for (let k = 0; k < 2; k++) {
        const c = makeRock(w, r.size - 1, r.x, r.y, speedMul(w));
        c.vx += r.vx * 0.35; c.vy += r.vy * 0.35;
        w.rocks.push(c);
      }
    }
  }

  // Advance one fixed tick. inputs: { [playerId]: bitmask }. Returns events for FX/audio.
  function step(w, inputs, dt = CFG.TICK) {
    const events = [];
    w.tick++;
    if (w.round === 0) startRound(w, events);

    for (const p of Object.values(w.players)) {
      const s = p.ship, bits = inputs[p.id] | 0;
      if (!s.alive) {
        if (p.lives > 0 && w.phase !== "gameover") {
          s.respawnT -= dt;
          if (s.respawnT <= 0 && trySpawn(w, p, false)) events.push({ type: "spawn", id: p.id });
        }
        continue;
      }
      if (bits & IN.LEFT) s.a -= CFG.TURN * dt;
      if (bits & IN.RIGHT) s.a += CFG.TURN * dt;
      s.thrusting = !!(bits & IN.THRUST);
      if (s.thrusting) { s.vx += Math.cos(s.a) * CFG.THRUST * dt; s.vy += Math.sin(s.a) * CFG.THRUST * dt; }
      const drag = Math.exp(-CFG.DRAG * dt); s.vx *= drag; s.vy *= drag;
      const sp = Math.hypot(s.vx, s.vy);
      if (sp > CFG.MAX_SPEED) { s.vx *= CFG.MAX_SPEED / sp; s.vy *= CFG.MAX_SPEED / sp; }
      s.x += s.vx * dt; s.y += s.vy * dt; wrap(s);
      s.invulnT = Math.max(0, s.invulnT - dt);
      s.cooldown = Math.max(0, s.cooldown - dt);
      if ((bits & IN.FIRE) && s.cooldown === 0 &&
          w.bullets.filter((b) => b.owner === p.id).length < CFG.MAX_BULLETS * (p.fireRate || 1)) {
        const cx = Math.cos(s.a), cy = Math.sin(s.a);
        w.bullets.push({ id: w.nextId++, owner: p.id,
          x: s.x + cx * CFG.SHIP_R, y: s.y + cy * CFG.SHIP_R,
          vx: s.vx + cx * CFG.BULLET_SPEED, vy: s.vy + cy * CFG.BULLET_SPEED, life: CFG.BULLET_LIFE });
        s.cooldown = CFG.FIRE_COOLDOWN / (p.fireRate || 1);
        events.push({ type: "shoot", id: p.id });
      }
    }

    for (const b of w.bullets) { b.x += b.vx * dt; b.y += b.vy * dt; wrap(b); b.life -= dt; }
    w.bullets = w.bullets.filter((b) => b.life > 0);

    for (const r of w.rocks) { r.x += r.vx * dt; r.y += r.vy * dt; r.a += r.spin * dt; wrap(r); }

    for (let bi = w.bullets.length - 1; bi >= 0; bi--) {
      const b = w.bullets[bi];
      for (let ri = 0; ri < w.rocks.length; ri++) {
        const r = w.rocks[ri];
        if (dist2(b, r) < (r.r * 0.92) ** 2) {
          w.bullets.splice(bi, 1);
          breakRock(w, ri, w.players[b.owner], events);
          break;
        }
      }
    }

    for (const p of Object.values(w.players)) {
      const s = p.ship;
      if (!s.alive || s.invulnT > 0) continue;
      const ri = w.rocks.findIndex((r) => dist2(s, r) < (r.r * 0.85 + CFG.SHIP_R * 0.8) ** 2);
      if (ri >= 0) { breakRock(w, ri, p, events); killShip(w, p, events); continue; }
      if (CFG.FRIENDLY_FIRE) {
        const bi = w.bullets.findIndex((b) => b.owner !== p.id && dist2(s, b) < CFG.SHIP_R ** 2);
        if (bi >= 0) { w.bullets.splice(bi, 1); killShip(w, p, events); }
      }
    }

    // Round flow: automatic restarts
    const plist = Object.values(w.players);
    if (w.phase === "playing") {
      if (plist.length && plist.every((p) => p.lives <= 0 && !p.ship.alive)) {
        w.phase = "gameover"; w.phaseT = CFG.GAMEOVER_PAUSE; events.push({ type: "gameover" });
      } else if (w.rocks.length === 0) {
        w.phase = "cleared"; w.phaseT = CFG.ROUND_PAUSE; events.push({ type: "cleared", round: w.round });
      }
    } else {
      w.phaseT -= dt;
      if (w.phaseT <= 0) (w.phase === "gameover" ? resetMatch : startRound)(w, events);
    }
    return events;
  }

  /* ---- Network snapshot: compact arrays, 1-decimal precision ---- */
  const r1 = (n) => Math.round(n * 10) / 10;
  const r3 = (n) => Math.round(n * 1000) / 1000;
  function encode(w) {
    return {
      tick: w.tick, phase: w.phase, round: w.round,
      players: Object.values(w.players).map((p) => [
        p.id, p.name, p.slot, p.score, p.lives,
        p.ship.alive ? 1 : 0, r1(p.ship.x), r1(p.ship.y), r1(p.ship.vx), r1(p.ship.vy), r3(p.ship.a),
        r1(p.ship.invulnT), p.ship.thrusting ? 1 : 0,
      ]),
      rocks: w.rocks.map((r) => [r.id, r.size, r1(r.x), r1(r.y), r1(r.vx), r1(r.vy), r3(r.a), r3(r.spin)]),
      bullets: w.bullets.map((b) => [b.id, b.owner, r1(b.x), r1(b.y), r1(b.vx), r1(b.vy)]),
    };
  }
  // Decode into the same shape the renderer reads from a local world.
  function decode(s) {
    const players = {};
    for (const a of s.players) {
      players[a[0]] = { id: a[0], name: a[1], slot: a[2], color: COLORS[a[2]], score: a[3], lives: a[4],
        ship: { alive: !!a[5], x: a[6], y: a[7], vx: a[8], vy: a[9], a: a[10], invulnT: a[11], thrusting: !!a[12] } };
    }
    return {
      tick: s.tick, phase: s.phase, round: s.round, players,
      rocks: s.rocks.map((a) => ({ id: a[0], size: a[1], r: CFG.ROCKS[a[1]].r, x: a[2], y: a[3], vx: a[4], vy: a[5], a: a[6], spin: a[7] })),
      bullets: s.bullets.map((a) => ({ id: a[0], owner: a[1], x: a[2], y: a[3], vx: a[4], vy: a[5] })),
    };
  }

  return { CFG, IN, COLORS, createWorld, addPlayer, removePlayer, step, rockShape, wrapXY, encode, decode };
});
