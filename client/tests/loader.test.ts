import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchJson, withRetry, loadAll, HttpError } from '../src/assets/loader.ts';

// Real local HTTP server: 200 json, 404, 500, corrupt json, slow (delay from path).
let server: http.Server;
let base = '';
let hits500 = 0;
test.before(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const m = /^\/slow\/(\d+)/.exec(url);
    if (m) return setTimeout(() => res.end('{"ok":true}'), Number(m[1]));
    if (url === '/ok.json') return res.end('{"ok":true}');
    if (url === '/corrupt.json') return res.end('{"width": 10, "height": ');
    if (url === '/flaky') { hits500++; res.statusCode = hits500 < 3 ? 500 : 200; return res.end('{"ok":true}'); }
    if (url === '/always500') { res.statusCode = 500; return res.end(); }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.after(() => server.close());
const noSleep = async () => {};

test('fetchJson: 404 rejects with HttpError (fetch alone would NOT)', async () => {
  const raw = await fetch(`${base}/nope`);
  assert.equal(raw.ok, false); // fetch fulfilled
  await assert.rejects(fetchJson(`${base}/nope`), (e: unknown) => e instanceof HttpError && e.status === 404);
});

test('fetchJson: corrupt JSON rejects with SyntaxError', async () => {
  await assert.rejects(fetchJson(`${base}/corrupt.json`), SyntaxError);
});

test('withRetry: retries 5xx until success, never retries 4xx', async () => {
  hits500 = 0;
  const r = await withRetry((s) => fetchJson(`${base}/flaky`, { signal: s }), { attempts: 3, sleepFn: noSleep });
  assert.deepEqual(r, { ok: true });
  assert.equal(hits500, 3);

  let calls = 0;
  await assert.rejects(withRetry(() => { calls++; return fetchJson(`${base}/nope`); }, { sleepFn: noSleep }));
  assert.equal(calls, 1, '4xx must not be retried');

  calls = 0;
  await assert.rejects(withRetry(() => { calls++; return fetchJson(`${base}/always500`); }, { attempts: 4, sleepFn: noSleep }));
  assert.equal(calls, 4);

  calls = 0;
  await assert.rejects(withRetry(() => { calls++; return fetchJson(`${base}/corrupt.json`); }, { sleepFn: noSleep }), SyntaxError);
  assert.equal(calls, 1, 'corrupt JSON must not be retried');
});

test('timeout: AbortSignal.timeout rejects a slow request', async () => {
  await assert.rejects(fetchJson(`${base}/slow/2000`, { signal: AbortSignal.timeout(100) }), (e: Error) => e.name === 'TimeoutError');
});

test('abort mid-load: loadAll rejects and does not swallow the abort', async () => {
  const c = new AbortController();
  const manifest = { arena: { url: `${base}/slow/2000`, required: true }, sounds: {} };
  const p = loadAll(manifest, { signal: c.signal });
  setTimeout(() => c.abort(), 50);
  await assert.rejects(p, (e: Error) => e.name === 'AbortError');
});

test('loadAll: optional failure -> null + listed in failures; progress reaches 1', async () => {
  const manifest = {
    arena: { url: `${base}/ok.json`, required: true },
    sprites: { url: `${base}/nope`, required: false },
    sounds: {},
  };
  const progress: number[] = [];
  const { assets, failures } = await loadAll(manifest, {
    onProgress: (p) => progress.push(p),
    loaders: { image: (url, s) => fetchJson(url, { signal: s }) }, // stand-in for Image in Node
    retry: { sleepFn: noSleep },
  });
  assert.deepEqual(assets.arena, { ok: true });
  assert.equal(assets.sprites, null);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.name, 'sprites');
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((p, i) => i === 0 || p >= (progress[i - 1] ?? 0)), 'progress is monotonic');
});

test('loadAll: required corrupt JSON rejects the whole load', async () => {
  const manifest = { arena: { url: `${base}/corrupt.json`, required: true }, sounds: {} };
  await assert.rejects(loadAll(manifest, { retry: { sleepFn: noSleep } }), SyntaxError);
});

test('loadAll: required failure aborts the sibling loads', async () => {
  let siblingAborted = false;
  const manifest = { arena: { url: `${base}/nope`, required: true }, sprites: { url: 'x', required: false }, sounds: {} };
  await assert.rejects(loadAll(manifest, {
    loaders: { image: (_u, s) => new Promise((_, rej) => s?.addEventListener('abort', () => { siblingAborted = true; rej(s.reason); })) },
    retry: { sleepFn: noSleep },
  }));
  assert.equal(siblingAborted, true);
});

test('concurrent vs sequential timing (5 x 300ms)', async () => {
  const urls = Array.from({ length: 5 }, () => `${base}/slow/300`);
  let t = performance.now();
  await Promise.all(urls.map((u) => fetchJson(u)));
  const concurrent = performance.now() - t;
  t = performance.now();
  for (const u of urls) await fetchJson(u);
  const sequential = performance.now() - t;
  console.log(`TIMING concurrent=${concurrent.toFixed(0)}ms sequential=${sequential.toFixed(0)}ms`);
  assert.ok(sequential > concurrent * 3);
});
