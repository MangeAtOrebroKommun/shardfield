/* Shardfield multiplayer server — Node core only, no npm dependencies.
   - Serves the static client from ./public
   - WebSocket endpoint at /ws?room=<name>&name=<player>
   - One authoritative world per room, stepped at 60 Hz, snapshots at 30 Hz.
   Matches live in memory; run a single replica. */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Sim = require("./public/sim.js");

const PORT = +process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, "public");
const SNAPSHOT_EVERY = 2; // ticks → 30 Hz
const MAX_ROOMS = 50;

/* ---------------- static files ---------------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml" };
function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
  if (url.pathname === "/rooms") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify([...rooms.values()].map((r) => ({ name: r.name, players: r.clients.size }))));
  }
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  });
}

/* ---------------- minimal WebSocket (RFC 6455) ---------------- */
function wsAccept(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key || (req.headers.upgrade || "").toLowerCase() !== "websocket") { socket.destroy(); return null; }
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  return socket;
}
function wsFrame(str, opcode = 1) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}
// Parses client frames (always masked). Calls onText(str) per text message.
function wsReader(socket, onText, onClose) {
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 1 << 20) return socket.destroy(); // 1 MB guard
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 65536) return socket.destroy();
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let data = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const m = buf.subarray(off, off + 4);
        data = Buffer.from(data);
        for (let i = 0; i < data.length; i++) data[i] ^= m[i & 3];
      }
      buf = buf.subarray(need);
      if (op === 0x8) { socket.end(wsFrame("", 0x8)); return; }       // close
      if (op === 0x9) { socket.write(wsFrame(data, 0xA)); continue; }  // ping → pong
      if (op === 0x1) onText(data.toString("utf8"));
    }
  });
  socket.on("close", onClose);
  socket.on("error", () => socket.destroy());
}

/* ---------------- leaderboard (JSON file on a persistent volume) ---------------- */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const LB_FILE = path.join(DATA_DIR, "leaderboard.json");
const LB_MAX_ENTRIES = 2000;
let board = []; // { name, score, round, room, at } sorted by score, best first
try { board = JSON.parse(fs.readFileSync(LB_FILE, "utf8")); console.log(`leaderboard: ${board.length} entries from ${LB_FILE}`); }
catch (e) { if (e.code !== "ENOENT") console.error("leaderboard load failed:", e.message); }
let saveTimer = null;
function saveBoardNow() {
  clearTimeout(saveTimer); saveTimer = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LB_FILE + ".tmp", JSON.stringify(board));
    fs.renameSync(LB_FILE + ".tmp", LB_FILE);
  } catch (e) { console.error("leaderboard save failed:", e.message); }
}
const saveBoard = () => { if (!saveTimer) saveTimer = setTimeout(saveBoardNow, 1000); };
// Best entry per name, optionally only entries newer than `since`.
function topList(since = 0, n = 10) {
  const seen = new Set(), out = [];
  for (const e of board) {
    if (e.at < since || seen.has(e.name)) continue;
    seen.add(e.name); out.push(e);
    if (out.length === n) break;
  }
  return out;
}
const WEEK = 7 * 24 * 3600 * 1000;
function leaderboard() { return { allTime: topList(0), week: topList(Date.now() - WEEK) }; }
// Record a finished run. Returns the all-time rank (1-10) if it made the list.
function record(room, name, score, round) {
  if (!(score > 0)) return null;
  const entry = { name: name || "PILOT", score, round, room: room.name, at: Date.now() };
  board.push(entry);
  board.sort((a, b) => b.score - a.score || a.at - b.at);
  if (board.length > LB_MAX_ENTRIES) board.length = LB_MAX_ENTRIES;
  saveBoard();
  const rank = topList(0).indexOf(entry) + 1;
  console.log(`score ${room.name}/${entry.name} ${score} (round ${round})${rank ? ` → #${rank}` : ""}`);
  if (rank) room.events.push({ type: "highscore", name: entry.name, score, rank });
  return rank || null;
}

/* ---------------- rooms ---------------- */
const rooms = new Map();
const clean = (s, max) => String(s || "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, max);

function getRoom(name) {
  let room = rooms.get(name);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return null;
    room = { name, world: Sim.createWorld(), inputs: {}, clients: new Map(), events: [], nextPlayer: 1, recorded: new Set() };
    rooms.set(name, room);
    console.log(`room + ${name}`);
  }
  return room;
}

/* A client is transport-agnostic: { id, kind, deliver(snapMsg), send(obj), close() }.
   WebSocket clients get frames pushed; HTTP clients long-poll /api/poll. */
function addClient(room, roomName, playerName, client) {
  const id = "p" + room.nextPlayer++;
  client.id = id; client.alive = true;
  Sim.addPlayer(room.world, id, playerName || undefined);
  room.clients.set(id, client);
  console.log(`join ${roomName}/${id} via ${client.kind} (${room.clients.size} players)`);
  return id;
}
function removeClient(room, id) {
  if (!room.clients.has(id)) return;
  const p = room.world.players[id];
  if (p && !room.recorded.has(id)) record(room, p.name, p.score, room.world.round); // left mid-match
  room.recorded.delete(id);
  room.clients.delete(id);
  delete room.inputs[id];
  Sim.removePlayer(room.world, id);
  console.log(`leave ${room.name}/${id} (${room.clients.size} players)`);
  if (room.clients.size === 0) { rooms.delete(room.name); console.log(`room - ${room.name}`); }
}
function admit(roomName) {
  const room = getRoom(roomName);
  if (!room) return { error: "Servern är full just nu." };
  if (room.clients.size >= Sim.CFG.MAX_PLAYERS) return { error: `Rummet "${roomName}" är fullt (max ${Sim.CFG.MAX_PLAYERS}).` };
  return { room };
}
function handleMsg(room, client, m) {
  client.alive = true;
  if (m.t === "in") room.inputs[client.id] = (m.b | 0) & 15;
  else if (m.t === "ping") client.send({ t: "pong", c: m.c });
}

/* ---- WebSocket transport ---- */
function joinWs(socket, roomName, playerName) {
  const { room, error } = admit(roomName);
  if (error) { socket.end(wsFrame(JSON.stringify({ t: "error", msg: error }))); return; }
  const client = {
    kind: "ws",
    send: (o) => socket.write(wsFrame(JSON.stringify(o))),
    deliver: (snapFrame) => { if (socket.writableLength < 256 * 1024) socket.write(snapFrame.ws); },
    close: () => socket.destroy(),
  };
  const id = addClient(room, roomName, playerName, client);
  client.send({ t: "welcome", id, room: roomName, transport: "ws" });
  wsReader(socket, (txt) => { let m; try { m = JSON.parse(txt); } catch { return; } handleMsg(room, client, m); },
    () => removeClient(room, id));
}

/* ---- HTTP long-poll transport (fallback when WebSockets are blocked) ---- */
const httpClients = new Map(); // token → { room, client }
function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(obj === undefined ? "" : JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 4096) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}
async function handleApi(req, res, url) {
  if (url.pathname === "/api/join" && req.method === "POST") {
    const body = await readBody(req);
    const roomName = clean(body.room, 24).toLowerCase() || "lobby";
    const { room, error } = admit(roomName);
    if (error) return json(res, 409, { t: "error", msg: error });
    const queue = [];          // messages waiting for the next poll
    let waiting = null;        // pending poll response
    const flush = () => {
      if (!waiting || !queue.length) return;
      const r = waiting; waiting = null; clearTimeout(r.timer);
      json(r, 200, queue.splice(0));
    };
    const client = {
      kind: "http",
      send: (o) => { queue.push(o); flush(); },
      deliver: (snap) => {
        // keep only the newest snapshot, but never drop events
        const prev = queue.findIndex((m) => m.t === "snap");
        if (prev >= 0) { const old = queue.splice(prev, 1)[0]; snap = { ...snap.obj, e: [...old.e, ...snap.obj.e] }; }
        else snap = snap.obj;
        queue.push(snap); flush();
      },
      close: () => { httpClients.delete(token); if (waiting) json(waiting, 410, []); },
      poll: (r) => {
        if (waiting) json(waiting, 200, []);
        waiting = r;
        r.timer = setTimeout(() => { if (waiting === r) { waiting = null; json(r, 200, []); } }, 5000);
        r.on("close", () => { if (waiting === r) waiting = null; });
        flush();
      },
    };
    const token = crypto.randomBytes(16).toString("hex");
    const id = addClient(room, roomName, clean(body.name, 12).toUpperCase(), client);
    httpClients.set(token, { room, client });
    return json(res, 200, { t: "welcome", id, room: roomName, token, transport: "http" });
  }
  if (url.pathname === "/api/leaderboard" && req.method === "GET") return json(res, 200, leaderboard());
  const token = url.searchParams.get("token") || "";
  const entry = httpClients.get(token);
  if (!entry) return json(res, 410, { t: "error", msg: "Sessionen har gått ut." });
  const { room, client } = entry;
  client.alive = true;
  if (url.pathname === "/api/poll" && req.method === "GET") return client.poll(res);
  if (url.pathname === "/api/send" && req.method === "POST") { handleMsg(room, client, await readBody(req)); return json(res, 204); }
  if (url.pathname === "/api/leave" && req.method === "POST") { client.close(); removeClient(room, client.id); return json(res, 204); }
  json(res, 404, { t: "error", msg: "not found" });
}

/* ---------------- loop ---------------- */
let tickCount = 0;
const TICK_MS = 1000 / 60;
let nextAt = performance.now();
function loop() {
  const now = performance.now();
  let steps = 0;
  while (now >= nextAt && steps < 5) {
    tickCount++; steps++; nextAt += TICK_MS;
    for (const room of rooms.values()) {
      const ev = Sim.step(room.world, room.inputs, Sim.CFG.TICK);
      for (const e of ev) {
        if (e.type === "shipDie" && e.final && !room.recorded.has(e.id)) { room.recorded.add(e.id); record(room, e.name, e.score, e.round); }
        else if (e.type === "round" && e.round === 1) room.recorded.clear(); // new match
      }
      if (ev.length) room.events.push(...ev);
      if (tickCount % SNAPSHOT_EVERY === 0) {
        const obj = { t: "snap", s: Sim.encode(room.world), e: room.events };
        const snap = { obj, ws: wsFrame(JSON.stringify(obj)) };
        room.events = [];
        for (const c of room.clients.values()) c.deliver(snap);
      }
    }
  }
  if (now - nextAt > 1000) nextAt = now; // fell far behind: resync
  setTimeout(loop, Math.max(0, nextAt - performance.now()));
}
loop();

// Drop clients that have gone silent (clients send input at least every second).
setInterval(() => {
  for (const room of rooms.values()) for (const c of [...room.clients.values()]) {
    if (!c.alive) { c.close(); removeClient(room, c.id); }
    else c.alive = false;
  }
}, 10000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url).catch(() => json(res, 500, { t: "error", msg: "serverfel" }));
  serveStatic(req, res);
});
server.keepAliveTimeout = 65000;
server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/ws") return socket.destroy();
  const roomName = clean(url.searchParams.get("room"), 24).toLowerCase() || "lobby";
  const playerName = clean(url.searchParams.get("name"), 12).toUpperCase();
  if (wsAccept(req, socket)) joinWs(socket, roomName, playerName);
});
server.listen(PORT, () => console.log(`Shardfield on :${PORT}`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => {
  for (const room of rooms.values()) for (const id of [...room.clients.keys()]) removeClient(room, id); // bank running scores
  saveBoardNow(); server.close(); process.exit(0);
});
