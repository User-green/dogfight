// Backpressure experiment: download a 200 MB match log through a slow reader, sample the SERVER's rss.
// Compares /api/replays (pipeline) with /api/replays-naive (readFile into memory).
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = '/tmp/dogfight-bp';
const SIZE_MB = Number(process.env.SIZE_MB ?? 200);
const RATE_MBPS = Number(process.env.RATE_MBPS ?? 20); // slow client: bytes/s the reader accepts
const PORT = 3222;

await mkdir(LOG_DIR, { recursive: true });
// Generate the file with a stream too (so generating it does not need 200 MB of RAM).
const line = JSON.stringify({ t: 1, type: 'chat', player: 'abcd1234', text: 'x'.repeat(100) }) + '\n';
async function* lines() { for (let n = 0; n < (SIZE_MB * 1024 * 1024) / line.length; n++) yield line; }
await pipeline(Readable.from(lines()), createWriteStream(join(LOG_DIR, 'big.ndjson')));

async function run(path) {
  const server = spawn('node', [join(here, '../src/index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LOG_DIR, ENABLE_DEBUG_ROUTES: '1' }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch { await sleep(100); } }
  const rss = async () => (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()).rss / 1048576;
  const series = [];
  const t0 = performance.now();
  const sampler = setInterval(async () => series.push([(performance.now() - t0) / 1000, await rss()]), 250);
  const baseline = await rss();
  await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${path}`, (res) => {
      // Throttle: pull one chunk, then wait chunk/RATE seconds before the next one.
      res.pause();
      let bytes = 0;
      res.on('data', async (chunk) => {
        bytes += chunk.length;
        res.pause();
        await sleep((chunk.length / (RATE_MBPS * 1048576)) * 1000);
        res.resume();
      });
      res.on('end', () => resolve(bytes));
      res.on('error', reject);
      res.resume();
    }).on('error', reject);
  });
  clearInterval(sampler);
  server.kill('SIGTERM');
  await sleep(300);
  return { baseline, series, peak: Math.max(...series.map((s) => s[1])) };
}

const results = {
  pipeline: await run('/api/replays/big'),
  naive: await run('/api/replays-naive/big'),
};
for (const [k, v] of Object.entries(results)) {
  console.log(`${k}: baseline ${v.baseline.toFixed(0)} MB, peak ${v.peak.toFixed(0)} MB, growth ${(v.peak - v.baseline).toFixed(0)} MB, ${v.series.at(-1)[0].toFixed(0)} s`);
}
await writeFile('/tmp/dogfight-bp-results.json', JSON.stringify({ SIZE_MB, RATE_MBPS, results }));
