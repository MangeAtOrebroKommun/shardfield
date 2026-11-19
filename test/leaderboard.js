// Plays a short session with a rapid-fire pilot, leaves, and checks the score lands on the
// leaderboard and survives a server restart (file persistence).
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shardfield-lb-"));
const PORT = 19080 + Math.floor(Math.random() * 1000);
const start = () => spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT, DATA_DIR } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
setTimeout(() => fail("timeout"), 20000);
(async () => {
  let srv = start(); await wait(400);
  const lb0 = await (await fetch(`http://localhost:${PORT}/api/leaderboard`)).json();
  if (!Array.isArray(lb0.allTime) || !Array.isArray(lb0.week)) fail("leaderboard shape");
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=lbtest&name=MrMange`);
  let score = 0, shots = 0, id;
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.t === "welcome") id = d.id;
    if (d.t === "snap") { const me = d.s.players.find((p) => p[0] === id); if (me) score = me[3]; shots += d.e.filter((e) => e.type === "shoot").length; } };
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ t: "in", b: 8 | 4 }));
  for (let i = 0; i < 16 && score === 0; i++) { await wait(500); ws.send(JSON.stringify({ t: "in", b: 8 | (i % 2 ? 4 : 2) })); }
  if (score === 0) fail("never scored, cannot test recording");
  ws.close(); await wait(1600); // leave → record → debounced save
  const lb1 = await (await fetch(`http://localhost:${PORT}/api/leaderboard`)).json();
  const top = lb1.allTime[0];
  if (!top || top.name !== "MRMANGE" || top.score !== score) fail("not recorded: " + JSON.stringify(lb1));
  srv.kill("SIGTERM"); await wait(400);
  srv = start(); await wait(400);
  const lb2 = await (await fetch(`http://localhost:${PORT}/api/leaderboard`)).json();
  if (lb2.allTime[0]?.score !== score) fail("not persisted across restart");
  console.log(`OK  MRMANGE scored ${score} with ${shots} shots, on board #1, persisted in ${DATA_DIR}`);
  srv.kill(); await wait(400); fs.rmSync(DATA_DIR, { recursive: true, force: true }); process.exit(0);
})().catch((e) => fail(e.message));
