// Starts the server, connects two WebSocket clients to the same room and checks
// they get welcomed, see each other in snapshots, and that input reaches the sim.
const { spawn } = require("child_process");
const path = require("path");
const PORT = 18080 + Math.floor(Math.random() * 1000);
const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT } });
srv.stderr.pipe(process.stderr);
const fail = (m) => { console.error("FAIL:", m); srv.kill(); process.exit(1); };
setTimeout(() => fail("timeout"), 8000);

function client(name, room = "test") {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}&name=${name}`);
    const c = { ws, snaps: [], events: [], id: null };
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.t === "welcome") { c.id = d.id; res(c); } if (d.t === "snap") { c.snaps.push(d.s); c.events.push(...d.e); } if (d.t === "error") c.error = d.msg; };
    ws.onerror = rej;
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await wait(400);
  const page = await fetch(`http://localhost:${PORT}/`); if (!(await page.text()).includes("SHARDFIELD")) fail("index not served");
  if ((await fetch(`http://localhost:${PORT}/healthz`)).status !== 200) fail("healthz");
  if ((await fetch(`http://localhost:${PORT}/../server.js`)).status === 200) fail("path traversal");
  const a = await client("ANNA"), b = await client("BO");
  // HTTP long-poll fallback client in the same room
  const j = await (await fetch(`http://localhost:${PORT}/api/join`, { method: "POST", body: JSON.stringify({ room: "test", name: "CECILIA" }) })).json();
  if (j.t !== "welcome" || !j.token) fail("http join");
  let hSnaps = 0, hShot = false, hLast = null, hRtt = false;
  (async () => { for (let i = 0; i < 200; i++) { const r = await fetch(`http://localhost:${PORT}/api/poll?token=${j.token}`); if (r.status !== 200) return;
    for (const m of await r.json()) { if (m.t === "snap") { hSnaps++; hLast = m.s; if (m.e.some((e) => e.type === "shoot" && e.id === j.id)) hShot = true; } if (m.t === "pong") hRtt = true; } } })();
  await fetch(`http://localhost:${PORT}/api/send?token=${j.token}`, { method: "POST", body: JSON.stringify({ t: "in", b: 8 }) });
  await fetch(`http://localhost:${PORT}/api/send?token=${j.token}`, { method: "POST", body: JSON.stringify({ t: "ping", c: 1 }) });
  a.ws.send(JSON.stringify({ t: "in", b: 8 | 4 })); // fire + rotate
  await wait(1500);
  const last = b.snaps.at(-1);
  if (!last || last.players.length !== 3) fail("b should see 3 players");
  const names = last.players.map((p) => p[1]).sort().join(",");
  if (names !== "ANNA,BO,CECILIA") fail("names " + names);
  if (hSnaps < 15 || !hShot || !hRtt || hLast.players.length !== 3) fail(`http client: snaps=${hSnaps} shot=${hShot} pong=${hRtt}`);
  await fetch(`http://localhost:${PORT}/api/leave?token=${j.token}`, { method: "POST" });
  if (!a.events.some((e) => e.type === "shoot" && e.id === a.id)) fail("a's shots not simulated");
  const rate = b.snaps.length / 1.5;
  const bytes = JSON.stringify(last).length;
  b.ws.close(); await wait(300);
  if (a.snaps.at(-1).players.length !== 1) fail("b and http client should be removed after leaving");
  const rooms = await (await fetch(`http://localhost:${PORT}/rooms`)).json();
  console.log(`OK  http snaps/1.5s=${hSnaps}  ws snapshots/s≈${rate.toFixed(0)}  snapshot≈${bytes} B  rooms=${JSON.stringify(rooms)}`);
  a.ws.close(); srv.kill(); process.exit(0);
})().catch((e) => fail(e.message));
