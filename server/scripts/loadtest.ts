// Load test: N headless `ws` clients join one room, each sends inputs at 30 Hz; sample /api/stats.
// Usage: node scripts/loadtest.ts <N> [seconds] [baseUrl]
// Silent: no browser, no audio. Prints one JSON line.
import WebSocket from 'ws';

const n = Number(process.argv[2] ?? 8);
const seconds = Number(process.argv[3] ?? 10);
const base = process.argv[4] ?? 'http://127.0.0.1:3000';
const wsUrl = `${base.replace('http', 'ws')}/ws`;

let bytes = 0;
let open = 0;
const sockets: WebSocket[] = [];
for (let i = 0; i < n; i++) {
  const ws = new WebSocket(wsUrl);
  ws.on('message', (d: Buffer) => {
    bytes += d.length;
  });
  ws.on('open', () => {
    open++;
    ws.send(JSON.stringify({ v: 1, type: 'join', room: 'alpha', name: `lt${i}` }));
  });
  ws.on('error', () => {});
  sockets.push(ws);
}
await new Promise((r) => setTimeout(r, 1500));
const t0 = Date.now();
const b0 = bytes;
const samples: { tickMs: number; tickMaxMs: number; elu: number; rss: number }[] = [];
for (let s = 0; s < seconds; s++) {
  await new Promise((r) => setTimeout(r, 1000));
  const st = (await (await fetch(`${base}/api/stats`)).json()) as {
    elu: number;
    rss: number;
    matches: Record<string, { tickMs: number; tickMaxMs: number }>;
  };
  const m = st.matches.alpha;
  if (m) samples.push({ tickMs: m.tickMs, tickMaxMs: m.tickMaxMs, elu: st.elu, rss: st.rss });
}
const elapsed = (Date.now() - t0) / 1000;
const last = samples.at(-1);
const p99 = [...samples].map((x) => x.tickMs).sort((a, b) => a - b)[Math.floor(samples.length * 0.99)] ?? 0;
console.log(JSON.stringify({ n, open, seconds: elapsed, tickMsP99: p99, tickMaxMs: last?.tickMaxMs, elu: last?.elu, rssMB: last ? Math.round(last.rss / 1e6) : 0, bytesPerSec: Math.round((bytes - b0) / elapsed) }));
for (const ws of sockets) ws.close();
process.exit(0);
