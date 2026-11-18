import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';
import { attachWs } from './ws.js';
import { serveStatic } from './static.js';
import { startMatchLog } from './log/matchlog.js';
import { Match } from './match.js';
import { validateCreateRoom, out } from './protocol.js';
import { CloseCode } from './protocol.js';

class BodyTooLarge extends Error {}

/** Read a request body into a string, aborting past `limit` bytes. */
async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const json = (res, status, body) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
};

export function createGameServer(config) {
  const manager = new RoomManager(config);
  const stats = {
    connections: 0,
    rejections: {},
    bytesIn: 0,
    bytesOut: 0,
    startedAt: Date.now(),
    reject(reason) {
      this.rejections[reason] = (this.rejections[reason] ?? 0) + 1;
    },
  };
  const logs = new Map(); // roomId -> active match log
  const matches = new Map(); // roomId -> Match (the authoritative simulation); runs only while the room has players

  const matchFor = (room) => {
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
      pending.then((log) => log.done.catch((err) => console.error('match log failed:', err)));
    });
    room.on('empty', () => {
      matches.get(room.id)?.stop();
      matches.delete(room.id);
      const pending = logs.get(room.id);
      logs.delete(room.id);
      pending?.then((log) => log.stop()).catch((err) => console.error('match log stop failed:', err));
    });
  });

  // Seed rooms (AFTER the 'created' listener above, or they would miss it); they are persistent (never deleted when empty).
  manager.create({ id: 'alpha', name: 'Alpha (easy)', asteroids: 3, persistent: true });
  manager.create({ id: 'bravo', name: 'Bravo', asteroids: 5, persistent: true });
  manager.create({ id: 'charlie', name: 'Charlie (hard)', asteroids: 8, persistent: true });

  const httpServer = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      if (err instanceof BodyTooLarge) return json(res, 413, { error: 'body-too-large' });
      console.error('request failed:', err);
      if (!res.headersSent) json(res, 500, { error: 'internal' });
      else res.destroy();
    }
  });

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    if (pathname === '/health') {
      return json(res, 200, { status: 'ok', uptime: process.uptime(), rss: process.memoryUsage.rss(), connections: stats.connections, rooms: manager.list().length });
    }
    if (pathname === '/api/stats') {
      const perMatch = Object.fromEntries([...matches].map(([id, m]) => [id, m.snapshotStats()]));
      return json(res, 200, { ...stats, rss: process.memoryUsage.rss(), matches: perMatch });
    }

    if (pathname === '/api/rooms') {
      if (req.method === 'GET') return json(res, 200, { rooms: manager.list() });
      if (req.method === 'POST') {
        let body;
        try {
          body = JSON.parse(await readBody(req, config.maxBodyBytes));
        } catch (err) {
          if (err instanceof BodyTooLarge) throw err;
          return json(res, 400, { error: 'bad-json' });
        }
        const v = validateCreateRoom(body);
        if (!v.ok) return json(res, 400, { error: v.reason });
        try {
          return json(res, 201, manager.create(v.value));
        } catch (err) {
          return json(res, 409, { error: err.message });
        }
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
      if (naive && !config.debugRoutes) return json(res, 404, { error: 'not-found' });
      const path = join(config.logDir, `${id}.ndjson`);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return json(res, 404, { error: 'not-found' });
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'content-length': info.size });
      if (naive) return res.end(await readFile(path)); // DEMO ONLY: buffers the whole file in memory
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

  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: config.maxPayload });
  attachWs(wss, manager, config, stats, matchFor);

  return {
    httpServer,
    wss,
    manager,
    stats,
    listen: () =>
      new Promise((resolve) => {
        httpServer.listen(config.port, config.host, () => resolve(httpServer.address()));
      }),
    /** Graceful shutdown: stop accepting, tell clients, close sockets, flush logs. */
    async stop() {
      const closed = new Promise((resolve) => httpServer.close(resolve)); // stops new connections
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
      await new Promise((resolve) => wss.close(resolve));
      httpServer.closeAllConnections();
      await closed;
    },
  };
}
