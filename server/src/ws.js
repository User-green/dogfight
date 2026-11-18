import { validate, out, CloseCode } from './protocol.js';
import { TokenBucket } from './rate-limit.js';

/**
 * Attach connection handling to a ws WebSocketServer.
 * Per-socket state lives in a WeakMap-free plain object on the socket (`socket.ctx`).
 */
export function attachWs(wss, manager, config, stats) {
  wss.on('connection', (socket) => {
    const ctx = (socket.ctx = {
      player: null,
      room: null,
      alive: true,
      missedPongs: 0,
      bucket: new TokenBucket({ capacity: config.msgBurst, perSecond: config.msgPerSecond }),
    });
    stats.connections++;

    // 'error' listener on EVERY socket: otherwise a socket error crashes the process.
    socket.on('error', (err) => console.error('socket error:', err.message));

    const joinTimer = setTimeout(() => {
      if (!ctx.player) socket.close(CloseCode.JOIN_TIMEOUT, 'join-timeout');
    }, config.joinTimeoutMs);

    socket.on('pong', () => (ctx.missedPongs = 0));

    socket.on('message', (data, isBinary) => {
      if (isBinary) return reject(socket, 'binary-not-supported');
      if (!ctx.bucket.take()) {
        stats.reject('rate-limit');
        return socket.close(CloseCode.RATE_LIMIT, 'rate-limit');
      }
      const res = validate(data);
      if (!res.ok) return reject(socket, res.reason, stats);
      const msg = res.msg;

      if (msg.type === 'join') {
        if (ctx.player) return reject(socket, 'already-joined', stats);
        const room = manager.get(msg.room);
        if (!room) return socket.close(CloseCode.NO_SUCH_ROOM, 'no-such-room');
        if (room.full) return socket.close(CloseCode.ROOM_FULL, 'room-full');
        clearTimeout(joinTimer);
        ctx.room = room;
        ctx.player = room.join(msg.name, socket);
        send(socket, out.welcome(ctx.player.id, room.toJSON()), config, true);
        broadcast(room, out.roster(room.roster()), config, true);
        return;
      }
      if (!ctx.player) return reject(socket, 'must-join-first', stats);
      if (msg.type === 'chat') {
        ctx.room.chat(ctx.player, msg.text);
        broadcast(ctx.room, out.chat(ctx.player.name, msg.text), config, false);
      }
    });

    socket.on('close', () => {
      clearTimeout(joinTimer);
      stats.connections--;
      if (ctx.player) {
        ctx.room.leave(ctx.player.id);
        broadcast(ctx.room, out.roster(ctx.room.roster()), config, true);
      }
    });
  });

  // Heartbeat: ping everyone; terminate sockets that missed two pongs (dead behind a NAT/proxy).
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const ctx = socket.ctx;
      if (!ctx) continue;
      if (ctx.missedPongs >= 2) {
        stats.reject('heartbeat');
        socket.terminate();
        continue;
      }
      ctx.missedPongs++;
      socket.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));
  return { heartbeat };
}

function reject(socket, reason, stats) {
  stats?.reject(reason);
  console.warn(`closing socket: ${reason}`);
  socket.close(CloseCode.BAD_PROTOCOL, reason);
}

/**
 * Slow-client policy: if the socket's outgoing buffer is above the threshold, drop
 * non-critical messages (chat); critical ones (roster/welcome) are still sent.
 * If even critical ones pile up to 4x the threshold, close the client.
 */
export function send(socket, payload, config, critical) {
  if (socket.readyState !== socket.OPEN) return;
  const buffered = socket.bufferedAmount;
  if (buffered > config.slowClientBytes) {
    if (!critical) return;
    if (buffered > config.slowClientBytes * 4) return socket.close(CloseCode.SLOW_CLIENT, 'slow-client');
  }
  socket.send(payload);
}

export function broadcast(room, payload, config, critical) {
  for (const p of room.players.values()) send(p.socket, payload, config, critical);
}
