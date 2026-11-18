import { describe, expect, test } from 'vitest';
import { once } from 'node:events';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.ts';
import { createGameServer } from '../src/server.ts';

async function start(overrides: Parameters<typeof loadConfig>[1] = {}, env: NodeJS.ProcessEnv = {}) {
  const server = createGameServer(loadConfig(env, { port: 0, host: '127.0.0.1', ...overrides }));
  const addr = await server.listen();
  return { server, base: `http://127.0.0.1:${addr.port}`, ws: `ws://127.0.0.1:${addr.port}/ws` };
}

/** Resolve with the HTTP status of a REFUSED handshake, or 101 if it connected. */
function handshake(url: string, origin?: string, headers?: Record<string, string>): Promise<{ status: number; socket: WebSocket }> {
  return new Promise((resolve) => {
    const opts: WebSocket.ClientOptions = { ...(origin ? { origin } : {}), ...(headers ? { headers } : {}) };
    const socket = new WebSocket(url, opts);
    socket.on('open', () => resolve({ status: 101, socket }));
    socket.on('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0, socket });
      res.resume();
    });
    socket.on('error', () => {});
  });
}

describe('production endpoints', () => {
  test('/health carries the version stamp, /ready flips to 503 on beginShutdown', async (t) => {
    const s = await start({ version: 'abc1234' });
    t.onTestFinished(() => s.server.stop());
    expect(((await (await fetch(`${s.base}/health`)).json()) as { version: string }).version).toBe('abc1234');
    expect((await fetch(`${s.base}/ready`)).status).toBe(200);
    s.server.beginShutdown();
    expect((await fetch(`${s.base}/ready`)).status).toBe(503);
    expect((await fetch(`${s.base}/health`)).status).toBe(200); // liveness stays up while draining
    expect((await handshake(s.ws)).status).toBe(503);
  });

  test('/metrics is Prometheus text with game gauges and rejections by reason', async (t) => {
    const s = await start({ allowedOrigins: ['https://game.example'] });
    t.onTestFinished(() => s.server.stop());
    await handshake(s.ws, 'https://evil.example'); // produces one 'origin' rejection
    const text = await (await fetch(`${s.base}/metrics`)).text();
    expect(text).toContain('# TYPE dogfight_players gauge');
    expect(text).toContain('dogfight_event_loop_utilization');
    expect(text).toContain('dogfight_rejections{reason="origin"} 1');
    expect(text).toContain('process_resident_memory_bytes');
  });
});

describe('handshake hardening', () => {
  test('origin allowlist: allowed passes, other and missing origin are refused with 403', async (t) => {
    const s = await start({ allowedOrigins: ['https://game.example'] });
    t.onTestFinished(() => s.server.stop());
    const ok = await handshake(s.ws, 'https://game.example');
    expect(ok.status).toBe(101);
    ok.socket.close();
    expect((await handshake(s.ws, 'https://evil.example')).status).toBe(403);
    expect((await handshake(s.ws)).status).toBe(403);
  });

  test('empty allowlist means no origin check (dev default)', async (t) => {
    const s = await start();
    t.onTestFinished(() => s.server.stop());
    const r = await handshake(s.ws, 'https://anything.example');
    expect(r.status).toBe(101);
    r.socket.close();
  });

  test('per-IP cap: the (N+1)th connection gets 429; a slot frees when one closes', async (t) => {
    const s = await start({ maxConnectionsPerIp: 2 });
    t.onTestFinished(() => s.server.stop());
    const a = await handshake(s.ws);
    const b = await handshake(s.ws);
    expect([a.status, b.status]).toEqual([101, 101]);
    expect((await handshake(s.ws)).status).toBe(429);
    expect(s.server.stats.rejections['ip-cap']).toBe(1);
    const closed = once(a.socket, 'close');
    a.socket.close();
    await closed;
    await new Promise((r) => setTimeout(r, 20));
    const c = await handshake(s.ws);
    expect(c.status).toBe(101);
    b.socket.close();
    c.socket.close();
  });

  test('trustProxy: honors X-Forwarded-For for per-IP cap when enabled', async (t) => {
    const s = await start({ maxConnectionsPerIp: 1, trustProxy: true });
    t.onTestFinished(() => s.server.stop());
    const a = await handshake(s.ws, undefined, { 'x-forwarded-for': '203.0.113.10, 127.0.0.1' });
    const b = await handshake(s.ws, undefined, { 'x-forwarded-for': '203.0.113.20, 127.0.0.1' });
    expect([a.status, b.status]).toEqual([101, 101]);
    expect((await handshake(s.ws, undefined, { 'x-forwarded-for': '203.0.113.10' })).status).toBe(429);
    a.socket.close();
    b.socket.close();
  });
});

describe('chaos', () => {
  test('a client flooding garbage is closed, counted, and does not disturb another room', async (t) => {
    const s = await start();
    t.onTestFinished(() => s.server.stop());
    const good = new WebSocket(s.ws);
    await once(good, 'open');
    good.send(JSON.stringify({ v: 1, type: 'join', room: 'bravo', name: 'Calm' }));
    await new Promise((r) => setTimeout(r, 300)); // let bravo's match tick a bit

    const bad = new WebSocket(s.ws);
    await once(bad, 'open');
    bad.on('error', () => {});
    const closed = once(bad, 'close');
    bad.send(JSON.stringify({ v: 1, type: 'join', room: 'alpha', name: 'Flood' }));
    for (let i = 0; i < 1000; i++) {
      if (bad.readyState !== WebSocket.OPEN) break;
      bad.send('garbage');
    }
    const [code] = (await closed) as [number];
    expect(code).toBe(4000);
    expect(Object.values(s.server.stats.rejections).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 300));

    // isolation: the other room's tick never blew its 33 ms budget
    const stats = (await (await fetch(`${s.base}/api/stats`)).json()) as { matches: Record<string, { overruns: number; tickMaxMs: number }> };
    expect(stats.matches.bravo?.overruns).toBe(0);
    good.close();
  });

  test('a client killed mid-match leaves the room and the roster shrinks', async (t) => {
    const s = await start();
    t.onTestFinished(() => s.server.stop());
    const a = new WebSocket(s.ws);
    await once(a, 'open');
    a.send(JSON.stringify({ v: 1, type: 'join', room: 'alpha', name: 'Victim' }));
    await new Promise((r) => setTimeout(r, 100));
    a.terminate(); // no close frame, like a pulled cable
    await new Promise((r) => setTimeout(r, 200));
    expect(s.server.stats.connections).toBe(0);
    expect(s.server.manager.get('alpha')?.players.size).toBe(0);
  });
});
