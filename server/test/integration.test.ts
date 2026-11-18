import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { parseServerMessage } from 'shared/protocol';
import type { ServerMessage } from 'shared/protocol';
import { loadConfig } from '../src/config.ts';
import { createGameServer } from '../src/server.ts';

async function start(overrides: Parameters<typeof loadConfig>[1] = {}) {
  const logDir = await mkdtemp(join(tmpdir(), 'dogfight-logs-'));
  const staticDir = await mkdtemp(join(tmpdir(), 'dogfight-static-'));
  await writeFile(join(staticDir, 'index.html'), '<h1>hi</h1>');
  await mkdir(join(staticDir, 'assets'));
  await writeFile(join(staticDir, 'assets', 'app-abcdef12.js'), 'console.log(1)');
  await writeFile(join(tmpdir(), 'dogfight-secret.txt'), 'secret');
  const config = loadConfig({}, { port: 0, host: '127.0.0.1', logDir, staticDir, debugRoutes: true, ...overrides });
  const server = createGameServer(config);
  const addr = await server.listen();
  return { server, config, logDir, base: `http://127.0.0.1:${addr.port}`, ws: `ws://127.0.0.1:${addr.port}/ws` };
}

type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

/** Client wrapper that collects parsed messages and lets tests await a specific one (by discriminant, narrowed). */
function client(url: string) {
  const socket = new WebSocket(url);
  const messages: ServerMessage[] = [];
  const waiters: { type: string; where: (m: never) => boolean; resolve: (m: never) => void }[] = [];
  let closeCode: number | null = null;
  const matches = (m: ServerMessage, type: string, where: (m: never) => boolean) => m.type === type && where(m as never);
  socket.on('message', (d) => {
    const parsed = parseServerMessage(JSON.parse(d.toString()));
    assert.ok(parsed.ok, 'server sent an invalid message');
    const m = parsed.value;
    messages.push(m);
    for (const w of [...waiters]) {
      if (matches(m, w.type, w.where)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m as never);
      }
    }
  });
  socket.on('close', (code) => (closeCode = code));
  socket.on('error', () => {});
  return {
    socket,
    messages,
    open: () => once(socket, 'open'),
    send: (o: object) => socket.send(JSON.stringify({ v: 1, ...o })),
    next: <T extends ServerMessage['type']>(type: T, where: (m: Of<T>) => boolean = () => true): Promise<Of<T>> =>
      new Promise((resolve, reject) => {
        const hit = messages.find((m): m is Of<T> => matches(m, type, where as (m: never) => boolean));
        if (hit) return resolve(hit);
        waiters.push({ type, where: where as (m: never) => boolean, resolve: resolve as (m: never) => void });
        setTimeout(() => reject(new Error('timeout waiting for message')), 2000).unref();
      }),
    closed: (): Promise<{ code: number }> =>
      new Promise((r) => (socket.readyState === WebSocket.CLOSED ? r({ code: closeCode ?? 1006 }) : socket.on('close', (code) => r({ code })))),
  };
}

test('HTTP: /health, rooms API, validation, body cap', async (t) => {
  const s = await start();
  t.after(() => s.server.stop());
  const health = (await (await fetch(`${s.base}/health`)).json()) as { status: string };
  assert.equal(health.status, 'ok');
  const rooms = (await (await fetch(`${s.base}/api/rooms`)).json()) as { rooms: { id: string }[] };
  assert.deepEqual(rooms.rooms.map((r) => r.id), ['alpha', 'bravo', 'charlie']);

  const post = (body: unknown) => fetch(`${s.base}/api/rooms`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
  const created = await post({ name: 'My Room', asteroids: 2 });
  assert.equal(created.status, 201);
  assert.match(((await created.json()) as { id: string }).id, /^my-room-/);
  assert.equal((await post('{nope')).status, 400);
  assert.equal((await post({ name: '' })).status, 400);
  assert.equal((await post({ name: 'x'.repeat(10_000) })).status, 413, 'body cap');
  assert.equal((await fetch(`${s.base}/api/rooms`, { method: 'DELETE' })).status, 405);
});

test('HTTP: static files, MIME, caching, path traversal guard', async (t) => {
  const s = await start();
  t.after(() => s.server.stop());
  const index = await fetch(`${s.base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(index.headers.get('cache-control'), 'no-cache');
  const asset = await fetch(`${s.base}/assets/app-abcdef12.js`);
  assert.match(asset.headers.get('content-type') ?? '', /javascript/);
  assert.match(asset.headers.get('cache-control') ?? '', /immutable/);
  assert.equal((await fetch(`${s.base}/missing.js`)).status, 404);
  // raw socket-level request so the client does not normalize ../ away
  for (const evil of ['/..%2f..%2f..%2ftmp%2fdogfight-secret.txt', '/%2e%2e/%2e%2e/tmp/dogfight-secret.txt', '/a%00b']) {
    const r = await fetch(`${s.base}${evil}`);
    assert.ok([400, 403, 404].includes(r.status), `${evil} -> ${r.status}`);
    assert.notEqual(await r.text(), 'secret');
  }
});

test('WS: two clients join, see roster and each other chat', async (t) => {
  const s = await start();
  t.after(() => s.server.stop());
  const a = client(s.ws), b = client(s.ws);
  await Promise.all([a.open(), b.open()]);
  a.send({ type: 'join', room: 'alpha', name: 'Ann' });
  await a.next('welcome');
  b.send({ type: 'join', room: 'alpha', name: 'Bob' });
  const roster = await a.next('roster', (m) => m.players.length === 2);
  assert.deepEqual(roster.players.map((p) => p.name).sort(), ['Ann', 'Bob']);
  a.send({ type: 'chat', text: 'hello' });
  const chat = await b.next('chat');
  assert.deepEqual([chat.from, chat.text], ['Ann', 'hello']);
  b.socket.close();
  await a.next('roster', (m) => m.players.length === 1);
  a.socket.close();
});

test('WS: abuse is closed with the right code', async (t) => {
  const s = await start({ joinTimeoutMs: 150, msgBurst: 5, msgPerSecond: 1 });
  t.after(() => s.server.stop());

  const noJoin = client(s.ws); await noJoin.open();
  assert.equal((await noJoin.closed()).code, 4001, 'join timeout');

  const garbage = client(s.ws); await garbage.open();
  garbage.socket.send('not json');
  assert.equal((await garbage.closed()).code, 4000, 'bad protocol');

  const unknownRoom = client(s.ws); await unknownRoom.open();
  unknownRoom.send({ type: 'join', room: 'nope', name: 'X' });
  assert.equal((await unknownRoom.closed()).code, 4004);

  const big = client(s.ws); await big.open();
  big.socket.send('x'.repeat(5000));
  assert.equal((await big.closed()).code, 1009, 'maxPayload');

  const binary = client(s.ws); await binary.open();
  binary.socket.send(Buffer.from([1, 2, 3]));
  assert.equal((await binary.closed()).code, 4000);

  const flood = client(s.ws); await flood.open();
  flood.send({ type: 'join', room: 'alpha', name: 'Flood' });
  for (let i = 0; i < 20; i++) flood.send({ type: 'chat', text: 'spam' });
  assert.equal((await flood.closed()).code, 4002, 'rate limit');
  assert.ok((s.server.stats.rejections['rate-limit'] ?? 0) >= 1);
});

test('WS: room player cap', async (t) => {
  const s = await start({ maxPlayersPerRoom: 1 });
  t.after(() => s.server.stop());
  const a = client(s.ws); await a.open();
  a.send({ type: 'join', room: 'alpha', name: 'A' });
  await a.next('welcome');
  const b = client(s.ws); await b.open();
  b.send({ type: 'join', room: 'alpha', name: 'B' });
  assert.equal((await b.closed()).code, 4003);
});

test('WS: heartbeat terminates a socket that never answers pings', async (t) => {
  const s = await start({ heartbeatMs: 40 });
  t.after(() => s.server.stop());
  const c = client(s.ws); await c.open();
  c.socket.pong = () => {}; // never reply
  (c.socket as unknown as { _receiver: EventEmitter })._receiver.removeAllListeners('ping'); // private ws field; the only cast in the tests, there is no public API for this // suppress ws's automatic pong
  c.socket.on('ping', () => {});
  c.send({ type: 'join', room: 'alpha', name: 'Ghost' });
  await c.next('welcome');
  await c.closed();
  assert.ok((s.server.stats.rejections.heartbeat ?? 0) >= 1);
});

test('match log: events are written as NDJSON and flushed when the room empties; replay streams it', async (t) => {
  const s = await start();
  t.after(() => s.server.stop());
  const a = client(s.ws); await a.open();
  a.send({ type: 'join', room: 'bravo', name: 'Logger' });
  await a.next('welcome');
  a.send({ type: 'chat', text: 'for the record' });
  await new Promise((r) => setTimeout(r, 50));
  a.socket.close();
  await new Promise((r) => setTimeout(r, 200)); // room empties -> log.stop() -> flush
  const files = (await readdir(s.logDir)).filter((f) => f.endsWith('.ndjson'));
  assert.equal(files.length, 1);
  const lines = (await readFile(join(s.logDir, files[0] ?? ''), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { type: string });
  assert.deepEqual(lines.map((l) => l.type), ['join', 'chat', 'leave']);
  const id = (files[0] ?? '').replace('.ndjson', '');
  const res = await fetch(`${s.base}/api/replays/${id}`);
  assert.equal(res.headers.get('content-type'), 'application/x-ndjson');
  assert.equal((await res.text()).trim().split('\n').length, 3);
  assert.equal((await fetch(`${s.base}/api/replays/..%2f..%2fetc%2fpasswd`)).status, 404);
  assert.equal((await fetch(`${s.base}/api/replays/nope`)).status, 404);
});

test('graceful shutdown: clients get a shutdown message and close code 1001; stop() resolves quickly', async () => {
  const s = await start();
  const a = client(s.ws); await a.open();
  a.send({ type: 'join', room: 'alpha', name: 'A' });
  await a.next('welcome');
  const t0 = performance.now();
  const closed = a.closed();
  await s.server.stop();
  const { code } = await closed;
  assert.equal(code, 1001);
  assert.ok(a.messages.some((m) => m.type === 'shutdown'));
  assert.ok(performance.now() - t0 < 2000);
});
