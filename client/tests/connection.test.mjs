import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { once } from 'node:events';
import { Connection } from '../src/net/connection.js';

async function server() {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const received = [];
  wss.on('connection', (s) => s.on('message', (d) => received.push(JSON.parse(d.toString()))));
  return { wss, received, url: `ws://127.0.0.1:${wss.address().port}` };
}
const until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return; await new Promise((r) => setTimeout(r, 10)); } throw new Error('timeout'); };
// adapt `ws` (EventEmitter API) to the browser's onopen/onmessage property API used by Connection
class BrowserLike extends WebSocket {}

test('queues messages while connecting, sends hello first, then queue in order', async () => {
  const s = await server();
  const c = new Connection({ url: s.url, WebSocketImpl: BrowserLike });
  c.send({ type: 'chat', text: 'one' });
  c.send({ type: 'chat', text: 'two' });
  c.connect({ v: 1, type: 'join', room: 'alpha', name: 'A' });
  await until(() => s.received.length === 3);
  assert.deepEqual(s.received.map((m) => m.type + (m.text ?? '')), ['join', 'chatone', 'chattwo']);
  c.close();
  s.wss.close();
});

test('dispatches by type and ignores garbage', async () => {
  const s = await server();
  s.wss.on('connection', (sock) => { sock.send('garbage'); sock.send(JSON.stringify({ v: 1, type: 'roster', players: [1] })); });
  const c = new Connection({ url: s.url, WebSocketImpl: BrowserLike });
  const got = new Promise((r) => c.addEventListener('roster', (e) => r(e.detail)));
  c.connect();
  assert.deepEqual((await got).players, [1]);
  c.close();
  s.wss.close();
});

test('reconnects with backoff after the server drops it, and re-sends hello', async () => {
  const s = await server();
  const c = new Connection({ url: s.url, baseMs: 20, maxMs: 100, WebSocketImpl: BrowserLike });
  const statuses = [];
  c.addEventListener('status', (e) => statuses.push(e.detail.status));
  c.connect({ v: 1, type: 'join', room: 'alpha', name: 'A' });
  await until(() => s.received.length === 1);
  for (const sock of s.wss.clients) sock.terminate(); // simulate server crash / network drop
  await until(() => s.received.length === 2, 5000); // hello again after reconnect
  assert.ok(statuses.includes('reconnecting'));
  assert.equal(statuses.at(-1), 'open');
  c.close();
  s.wss.close();
});

test('does not retry on fatal close codes (room full)', async () => {
  const s = await server();
  s.wss.on('connection', (sock) => sock.close(4003, 'room-full'));
  const c = new Connection({ url: s.url, baseMs: 10, WebSocketImpl: BrowserLike });
  const closed = new Promise((r) => c.addEventListener('status', (e) => e.detail.status === 'closed' && r(e.detail)));
  c.connect();
  assert.equal((await closed).code, 4003);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(c.status, 'closed');
  s.wss.close();
});
