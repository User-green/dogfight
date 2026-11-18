import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer } from 'ws';
import { RoomManager, type Room } from './rooms.ts';
import { attachWs, type ServerStats } from './ws.ts';
import type { ServerConfig } from './config.ts';
import { serveStatic } from './static.ts';
import { startMatchLog, type MatchLog } from './log/matchlog.ts';
import { log as logger } from './logger.ts';
import { Registry, Gauge, collectDefaultMetrics } from 'prom-client';
import { Match } from './match.ts';
import { validateCreateRoom, out, CloseCode } from './protocol.ts';

class BodyTooLarge extends Error {}

/** Read a request body into a string, aborting past `limit` bytes. */
async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
};

export function createGameServer(config: ServerConfig) {
  const manager = new RoomManager(config);
  const stats: ServerStats = {
    connections: 0,
    rejections: {},
    bytesIn: 0,
    bytesOut: 0,
    startedAt: Date.now(),
    reject(reason: string) {
      this.rejections[reason] = (this.rejections[reason] ?? 0) + 1;
    },
  };
  let shuttingDown = false;

  // Prometheus metrics: gauges are read at scrape time from the live objects, so there is nothing to keep in sync.
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const gauge = (name: string, help: string, collect: () => number) => new Gauge({ name, help, registers: [registry], collect() { this.set(collect()); } });
  gauge('dogfight_players', 'Connected WebSocket connections', () => stats.connections);
  gauge('dogfight_rooms', 'Rooms', () => manager.list().length);
  gauge('dogfight_bytes_in_total', 'Bytes received over WebSocket', () => stats.bytesIn);
  gauge('dogfight_bytes_out_total', 'Bytes sent over WebSocket', () => stats.bytesOut);
  gauge('dogfight_event_loop_utilization', 'Event loop utilization since start (0..1)', () => performance.eventLoopUtilization().utilization);
  gauge('dogfight_tick_ms_max', 'Worst tick duration over all matches (ms)', () => Math.max(0, ...[...matches.values()].map((m) => m.stats.tickMaxMs)));
  gauge('dogfight_tick_ms_ewma_max', 'Highest per-match tick EWMA (ms)', () => Math.max(0, ...[...matches.values()].map((m) => m.stats.tickMs)));
  new Gauge({
    name: 'dogfight_rejections',
    help: 'Rejected connections/messages by reason',
    labelNames: ['reason'],
    registers: [registry],
    collect() {
      this.reset();
      for (const [reason, n] of Object.entries(stats.rejections)) this.set({ reason }, n);
    },
  });
  const logs = new Map<string, Promise<MatchLog>>(); // roomId -> active match log
  const matches = new Map<string, Match>(); // roomId -> Match (the authoritative simulation); runs only while the room has players

  const matchFor = (room: Room): Match => {
    let m = matches.get(room.id);
    if (!m) {
      m = new Match({ asteroids: room.asteroids });
      matches.set(room.id, m);
      m.start();
    }
    return m;
  };

  // Match log lifecycle: starts when the first player joins, ends (and flushes) when the room empties.
  manager.on('created', (room) => {
    room.on('join', () => {
      if (logs.has(room.id)) return;
      const pending = startMatchLog(room, config.logDir);
      logs.set(room.id, pending);
      void pending.then((log) => log.done.catch((err: unknown) => logger.error({ event: 'matchlog.failed', err })));
    });
    room.on('empty', () => {
      matches.get(room.id)?.stop();
      matches.delete(room.id);
      const pending = logs.get(room.id);
      logs.delete(room.id);
      pending?.then((log) => log.stop()).catch((err: unknown) => logger.error({ event: 'matchlog.stop.failed', err }));
    });
  });

  // Seed rooms (AFTER the 'created' listener above, or they would miss it); they are persistent (never deleted when empty).
  manager.create({ id: 'alpha', name: 'Alpha (easy)', asteroids: 3, persistent: true });
  manager.create({ id: 'bravo', name: 'Bravo', asteroids: 5, persistent: true });
  manager.create({ id: 'charlie', name: 'Charlie (hard)', asteroids: 8, persistent: true });

  const httpServer = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err: unknown) {
      if (err instanceof BodyTooLarge) return json(res, 413, { error: 'body-too-large' });
      logger.error({ event: 'http.request.failed', err });
      if (!res.headersSent) json(res, 500, { error: 'internal' });
      else res.destroy();
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;

    if (pathname === '/health') {
      return json(res, 200, { status: 'ok', version: config.version, uptime: process.uptime(), rss: process.memoryUsage.rss(), connections: stats.connections, rooms: manager.list().length });
    }
    // Readiness: can we take NEW traffic? False while draining, so the platform stops routing to us before we exit.
    if (pathname === '/ready') {
      return json(res, shuttingDown ? 503 : 200, { ready: !shuttingDown, version: config.version });
    }
    if (pathname === '/metrics') {
      res.writeHead(200, { 'content-type': registry.contentType });
      return void res.end(await registry.metrics());
    }
    if (pathname === '/api/stats') {
      const perMatch = Object.fromEntries([...matches].map(([id, m]) => [id, m.snapshotStats()]));
      const mem = process.memoryUsage();
      const elu = performance.eventLoopUtilization();
      return json(res, 200, { ...stats, rss: mem.rss, heapUsed: mem.heapUsed, elu: Math.round(elu.utilization * 1000) / 1000, matches: perMatch });
    }

    if (pathname === '/api/rooms') {
      if (req.method === 'GET') return json(res, 200, { rooms: manager.list() });
      if (req.method === 'POST') {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req, config.maxBodyBytes));
        } catch (err: unknown) {
          if (err instanceof BodyTooLarge) throw err;
          return json(res, 400, { error: 'bad-json' });
        }
        const v = validateCreateRoom(body);
        if (!v.ok) return json(res, 400, { error: v.error });
        try {
          return json(res, 201, manager.create(v.value));
        } catch (err: unknown) {
          return json(res, 409, { error: err instanceof Error ? err.message : 'conflict' });
        }
      }
      return json(res, 405, { error: 'method-not-allowed' });
    }

    const botsRoute = /^\/api\/rooms\/([\w-]+)\/bots$/.exec(pathname);
    if (botsRoute) {
      const room = manager.get(botsRoute[1] ?? '');
      if (!room) return json(res, 404, { error: 'no-such-room' });
      if (req.method === 'POST') {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req, config.maxBodyBytes));
        } catch (err: unknown) {
          if (err instanceof BodyTooLarge) throw err;
          return json(res, 400, { error: 'bad-json' });
        }
        const count = typeof body === 'object' && body !== null && 'count' in body ? body.count : undefined;
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > config.maxBots) return json(res, 400, { error: 'bad-count' });
        const match = matchFor(room);
        if (match.bots.size + count > config.maxBots) return json(res, 409, { error: 'too-many-bots' });
        for (let i = 0; i < count; i++) match.addBot();
        return json(res, 201, { room: room.id, bots: match.bots.size });
      }
      if (req.method === 'DELETE') {
        const match = matches.get(room.id);
        const removed = match?.removeBots() ?? 0;
        return json(res, 200, { room: room.id, removed });
      }
      return json(res, 405, { error: 'method-not-allowed' });
    }

    if (pathname === '/api/replays' && req.method === 'GET') {
      const files = await readdir(config.logDir).catch(() => []);
      return json(res, 200, { replays: files.filter((f) => f.endsWith('.ndjson')).map((f) => f.replace(/\.ndjson$/, '')) });
    }

    const replayMatch = /^\/api\/replays(-naive)?\/([\w.-]+)$/.exec(pathname);
    if (replayMatch && req.method === 'GET') {
      const [, naive, id] = replayMatch;
      if (id === undefined) return json(res, 404, { error: 'not-found' });
      if (naive && !config.debugRoutes) return json(res, 404, { error: 'not-found' });
      const path = join(config.logDir, `${id}.ndjson`);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return json(res, 404, { error: 'not-found' });
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'content-length': info.size });
      if (naive) {
        res.end(await readFile(path)); // DEMO ONLY: buffers the whole file in memory
        return;
      }
      // pipeline: respects backpressure from `res`, cleans up if the client disconnects.
      return pipeline(createReadStream(path), res).catch(() => {});
    }

    if (config.debugRoutes && pathname === '/api/slow') {
      const end = performance.now() + 300;
      while (performance.now() < end); // DEMO ONLY: blocks the single JS thread for 300 ms
      return json(res, 200, { blocked: 300 });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (await serveStatic(config.staticDir, pathname, res)) return;
    }
    json(res, 404, { error: 'not-found' });
  }

  // Handshake gate, BEFORE the upgrade completes: browsers do not apply CORS to WebSockets, so the server must check Origin itself.
  const ipCounts = new Map<string, number>();
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: config.maxPayload,
    verifyClient: (info, done) => {
      if (shuttingDown) return done(false, 503, 'shutting-down');
      if (config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(info.origin)) {
        stats.reject('origin');
        logger.warn({ event: 'ws.rejected', reason: 'origin', origin: info.origin });
        return done(false, 403, 'origin-not-allowed');
      }
      const ip = info.req.socket.remoteAddress ?? 'unknown';
      if ((ipCounts.get(ip) ?? 0) >= config.maxConnectionsPerIp) {
        stats.reject('ip-cap');
        logger.warn({ event: 'ws.rejected', reason: 'ip-cap', ip });
        return done(false, 429, 'too-many-connections');
      }
      done(true);
    },
  });
  attachWs(wss, manager, config, stats, matchFor, ipCounts);

  return {
    httpServer,
    wss,
    manager,
    stats,
    listen: (): Promise<AddressInfo> =>
      new Promise((resolve, reject) => {
        httpServer.listen(config.port, config.host, () => {
          const addr = httpServer.address();
          if (addr !== null && typeof addr === 'object') resolve(addr);
          else reject(new Error('server has no TCP address'));
        });
      }),
    /** Flip readiness to false (and refuse new upgrades) before the actual drain starts. */
    beginShutdown(): void {
      shuttingDown = true;
    },
    /** Graceful shutdown: stop accepting, tell clients, close sockets, flush logs. */
    async stop(): Promise<void> {
      shuttingDown = true;
      const closed = new Promise<void>((resolve) => httpServer.close(() => resolve())); // stops new connections
      for (const socket of wss.clients) {
        if (socket.readyState === socket.OPEN) {
          socket.send(out.shutdown());
          socket.close(CloseCode.GOING_AWAY, 'server-shutdown');
        }
      }
      for (const m of matches.values()) m.stop();
      matches.clear();
      const pending = [...logs.values()];
      logs.clear();
      await Promise.all(pending.map((p) => p.then((log) => log.stop()).catch(() => {})));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      httpServer.closeAllConnections();
      await closed;
    },
  };
}
