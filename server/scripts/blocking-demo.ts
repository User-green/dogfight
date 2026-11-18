// What a 300 ms synchronous handler does to every other client: measure chat round-trip latency.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

const PORT = 3223;
const server = spawn('node', [join(dirname(fileURLToPath(import.meta.url)), '../src/index.ts')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LOG_DIR: '/tmp/dogfight-block', ENABLE_DEBUG_ROUTES: '1', MSG_BURST: '1000', MSG_PER_SECOND: '1000' }, stdio: 'ignore',
});
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await once(ws, 'open');
const pending = new Map();
ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'chat') { pending.get(m.text)?.(performance.now()); } });
ws.send(JSON.stringify({ v: 1, type: 'join', room: 'alpha', name: 'Probe' }));
await sleep(200);

async function probe(durationMs) {
  const lat = [];
  const end = performance.now() + durationMs;
  let i = 0;
  while (performance.now() < end) {
    const id = `p${i++}`;
    const t0 = performance.now();
    const got = new Promise((r) => pending.set(id, r));
    ws.send(JSON.stringify({ v: 1, type: 'chat', text: id }));
    lat.push((await got) - t0);
    await sleep(25);
  }
  lat.sort((a, b) => a - b);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))];
  return { n: lat.length, p50: q(0.5), p99: q(0.99), max: lat.at(-1) };
}
const fmt = (r) => `n=${r.n} p50=${r.p50.toFixed(1)}ms p99=${r.p99.toFixed(1)}ms max=${r.max.toFixed(1)}ms`;

console.log('idle           :', fmt(await probe(3000)));
// Another client hammers the blocking endpoint
let hammer = true;
(async () => { while (hammer) await fetch(`http://127.0.0.1:${PORT}/api/slow`); })();
console.log('while /api/slow:', fmt(await probe(3000)));
hammer = false;
ws.close();
server.kill('SIGTERM');
