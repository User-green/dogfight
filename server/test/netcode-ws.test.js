// Lab 5: the websocket path of the netcode (input in, snapshots out) against a real server, JSON and binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { codecs } from 'shared/codec/index';
import { loadConfig } from '../src/config.js';
import { createGameServer } from '../src/server.js';

async function start(overrides = {}) {
  const logDir = await mkdtemp(join(tmpdir(), 'dogfight-logs-'));
  const config = loadConfig({}, { port: 0, host: '127.0.0.1', logDir, ...overrides });
  const server = createGameServer(config);
  const addr = await server.listen();
  return { server, url: `ws://127.0.0.1:${addr.port}/ws` };
}

/** Raw client: keeps text messages (parsed) and binary frames (as Buffers) separately. */
function raw(url) {
  const socket = new WebSocket(url);
  const text = [];
  const bin = [];
  let closed = null;
  socket.on('message', (d, isBinary) => (isBinary ? bin.push(Buffer.from(d)) : text.push(JSON.parse(d.toString()))));
  socket.on('close', (code) => (closed = code));
  socket.on('error', () => {});
  const until = async (pred, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = pred();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timeout');
  };
  return {
    socket, text, bin, until,
    open: () => once(socket, 'open'),
    sendJson: (o) => socket.send(JSON.stringify({ v: 1, ...o })),
    join: (codec, name = 'p') => socket.send(JSON.stringify({ v: 1, type: 'join', room: 'alpha', name, codec })),
    closedCode: () => closed,
  };
}

const keys = (seq) => ({ seq, thrust: true, turn: 0, fire: false });

test('JSON: join -> welcome with shipId, snapshots carry ack, input advances ack', async (t) => {
  const s = await start();
  t.after(() => s.server.stop());
  const c = raw(s.url);
  await c.open();
  c.join('json');
  const welcome = await c.until(() => c.text.find((m) => m.type === 'welcome'));
  assert.equal(welcome.codec, 'json');
  assert.equal(typeof welcome.shipId, 'number');
  assert.equal(welcome.tickRate, 30);
  await c.until(() => c.text.some((m) => m.type === 'snapshot'));
  for (let i = 1; i <= 5; i++) c.sendJson({ type: 'input', tick: 0, inputs: [keys(i)] });
  const snap = await c.until(() => c.text.findLast((m) => m.type === 'snapshot' && m.ack === 5));
  assert.ok(snap.ents.some((e) => e.id === welcome.shipId), 'my ship is in the snapshot');
  c.socket.close();
});

test('binary: snapshots are binary frames, a 22-byte input packet is accepted and acked', async (t) => {
  const s = await start();
  t.after(() => s.server.stop());
  const c = raw(s.url);
  await c.open();
  c.join('binary');
  const welcome = await c.until(() => c.text.find((m) => m.type === 'welcome'));
  assert.equal(welcome.codec, 'binary');
  await c.until(() => c.bin.length > 2);
  assert.equal(c.text.some((m) => m.type === 'snapshot'), false, 'no JSON snapshots on a binary connection');
  const packet = codecs.binary.encodeInputPacket({ tick: 0, inputs: [keys(1), keys(2), keys(3)] });
  assert.equal(packet.byteLength, 22);
  c.socket.send(packet);
  await c.until(() => c.bin.some((b) => codecs.binary.decodeSnapshot(b).ack === 3));
  c.socket.close();
});

test('bad input: a garbage binary frame closes the socket with BAD_PROTOCOL (4000)', async (t) => {
  const s = await start();
  t.after(() => s.server.stop());
  const c = raw(s.url);
  await c.open();
  c.join('binary');
  await c.until(() => c.text.find((m) => m.type === 'welcome'));
  c.socket.send(Buffer.from([0xff, 1, 2, 3]));
  await c.until(() => c.closedCode() !== null);
  assert.equal(c.closedCode(), 4000);
});

test('binary frame before join closes the socket (4000)', async (t) => {
  const s = await start();
  t.after(() => s.server.stop());
  const c = raw(s.url);
  await c.open();
  c.socket.send(codecs.binary.encodeInputPacket({ tick: 0, inputs: [keys(1)] }));
  await c.until(() => c.closedCode() !== null);
  assert.equal(c.closedCode(), 4000);
});

test('input flood is cut off by its own token bucket (RATE_LIMIT 4002)', async (t) => {
  const s = await start({ inputBurst: 20, inputPerSecond: 5 });
  t.after(() => s.server.stop());
  const c = raw(s.url);
  await c.open();
  c.join('json');
  await c.until(() => c.text.find((m) => m.type === 'welcome'));
  for (let i = 1; i <= 200; i++) c.sendJson({ type: 'input', tick: 0, inputs: [keys(i)] });
  await c.until(() => c.closedCode() !== null);
  assert.equal(c.closedCode(), 4002);
});

test('netsim: ?lag= delays the pong when ENABLE_NETSIM is on, and is ignored when off', async (t) => {
  const measure = async (allow) => {
    const s = await start({ allowNetsim: allow });
    t.after(() => s.server.stop());
    const c = raw(`${s.url}?lag=200`);
    await c.open();
    c.join('json');
    await c.until(() => c.text.find((m) => m.type === 'welcome'));
    const t0 = Date.now();
    c.sendJson({ type: 'ping', t: t0 });
    await c.until(() => c.text.find((m) => m.type === 'pong'), 3000);
    const rtt = Date.now() - t0;
    c.socket.close();
    return rtt;
  };
  const on = await measure(true);
  const off = await measure(false);
  assert.ok(on >= 180, `lag 200 ms honoured, got ${on}`);
  assert.ok(off < 100, `lag ignored when disabled, got ${off}`);
});
