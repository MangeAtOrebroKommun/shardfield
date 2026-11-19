// Usage: node test/remote.js https://shardfield.example.com
// Connects two players to a throwaway room on a deployed server and checks the round trip.
const base = new URL(process.argv[2] || "http://localhost:8080");
const wsBase = `${base.protocol === "https:" ? "wss" : "ws"}://${base.host}`;
const room = "smoke-" + Date.now().toString(36);
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
setTimeout(() => fail("timeout"), 10000);
const client = (name) => new Promise((res, rej) => {
  const ws = new WebSocket(`${wsBase}/ws?room=${room}&name=${name}`);
  const c = { ws, snaps: 0, last: null, rtt: null, id: null };
  ws.onmessage = (m) => { const d = JSON.parse(m.data);
    if (d.t === "welcome") { c.id = d.id; res(c); }
    if (d.t === "snap") { c.snaps++; c.last = d.s; }
    if (d.t === "pong") c.rtt = performance.now() - d.c; };
  ws.onerror = (e) => rej(new Error("websocket error " + (e.message || "")));
});
(async () => {
  const a = await client("SMOKEA"), b = await client("SMOKEB");
  a.ws.send(JSON.stringify({ t: "ping", c: performance.now() }));
  const t0 = performance.now(); await new Promise((r) => setTimeout(r, 2000));
  const secs = (performance.now() - t0) / 1000;
  if (!b.last || b.last.players.length !== 2) fail("expected 2 players");
  console.log(`OK  ${base.host}  room=${room}  snapshots/s≈${(b.snaps / secs).toFixed(0)}  rtt≈${a.rtt?.toFixed(0)} ms`);
  a.ws.close(); b.ws.close(); setTimeout(() => process.exit(0), 200);
})().catch((e) => fail(e.message));
