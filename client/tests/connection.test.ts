import { test } from 'vitest';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Connection } from '../src/net/connection.ts';
import type { StatusDetail, WebSocketLike } from '../src/net/connection.ts';

async function server() {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const received: { type: string; text?: string }[] = [];
  wss.on('connection', (s) => s.on('message', (d) => received.push(JSON.parse(d.toString()) as { type: string; text?: string })));
  return { wss, received, url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` };
}
const until = async (pred: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return; await new Promise((r) => setTimeout(r, 10)); } throw new Error('timeout'); };
/** Adapts `ws` (EventEmitter API) to the browser-style onopen/onmessage property API that Connection uses (WebSocketLike). */
class BrowserLike implements WebSocketLike {
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  readonly #ws: WebSocket;
  constructor(url: string) {
    this.#ws = new WebSocket(url);
    this.#ws.on('open', () => this.onopen?.());
    this.#ws.on('message', (data: Buffer, isBinary: boolean) => {
      this.onmessage?.({ data: isBinary ? new Uint8Array(data).buffer : data.toString() });
    });
    this.#ws.on('error', () => this.onerror?.());
    this.#ws.on('close', (code, reason) => this.onclose?.({ code, reason: reason.toString() }));
  }
  get readyState(): number {
    return this.#ws.readyState;
  }
  send(data: string | ArrayBuffer): void {
    this.#ws.send(data);
  }
  close(): void {
    this.#ws.close();
  }
}

test('queues messages while connecting, sends hello first, then queue in order', async () => {
  const s = await server();
  const c = new Connection({ url: s.url, WebSocketImpl: BrowserLike });
  c.send({ type: 'chat', text: 'one' });
  c.send({ type: 'chat', text: 'two' });
  c.connect({ v: 1, type: 'join', room: 'alpha', name: 'A', codec: 'json' });
  await until(() => s.received.length === 3);
  assert.deepEqual(s.received.map((m) => m.type + (m.text ?? '')), ['join', 'chatone', 'chattwo']);
  c.close();
  s.wss.close();
});

test('dispatches by type and ignores garbage', async () => {
  const s = await server();
  s.wss.on('connection', (sock) => { sock.send('garbage'); sock.send(JSON.stringify({ v: 1, type: 'roster', players: [{ id: 'p1', name: 'P' }] })); });
  const c = new Connection({ url: s.url, WebSocketImpl: BrowserLike });
  const got = new Promise<{ players: { id: string; name: string }[] }>((r) => c.on('roster', r));
  c.connect();
  assert.deepEqual((await got).players, [{ id: 'p1', name: 'P' }]);
  c.close();
  s.wss.close();
});

test('reconnects with backoff after the server drops it, and re-sends hello', async () => {
  const s = await server();
  const c = new Connection({ url: s.url, baseMs: 20, maxMs: 100, WebSocketImpl: BrowserLike });
  const statuses: string[] = [];
  c.on('status', (d) => statuses.push(d.status));
  c.connect({ v: 1, type: 'join', room: 'alpha', name: 'A', codec: 'json' });
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
  const closed = new Promise<StatusDetail>((r) => c.on('status', (d) => d.status === 'closed' && r(d)));
  c.connect();
  assert.equal((await closed).code, 4003);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(c.status, 'closed');
  s.wss.close();
});
