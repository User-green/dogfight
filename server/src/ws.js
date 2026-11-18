import { validate, out, CloseCode } from './protocol.js';
import { TokenBucket } from './rate-limit.js';
import { NetSim, validateNetsim } from './netsim.js';
import { codecs } from 'shared/codec/index';
import { BinType, CodecError } from 'shared/protocol';
import { TICK_RATE, ARENA } from 'shared/constants';

/**
 * Attach connection handling to a ws WebSocketServer.
 * Per-socket state lives in a WeakMap-free plain object on the socket (`socket.ctx`).
 */
export function attachWs(wss, manager, config, stats, matchFor) {
  wss.on('connection', (socket, req) => {
    const ctx = (socket.ctx = {
      player: null,
      room: null,
      alive: true,
      missedPongs: 0,
      bucket: new TokenBucket({ capacity: config.msgBurst, perSecond: config.msgPerSecond }),
      // inputs flow at 30/s, so they get their own (bigger) bucket: chat spam cannot starve input and vice versa
      inputBucket: new TokenBucket({ capacity: config.inputBurst, perSecond: config.inputPerSecond }),
      codec: 'json',
      netsim: new NetSim(config.allowNetsim ? netsimFromUrl(req.url) : {}),
      match: null,
    });
    stats.connections++;

    // 'error' listener on EVERY socket: otherwise a socket error crashes the process.
    socket.on('error', (err) => console.error('socket error:', err.message));

    const joinTimer = setTimeout(() => {
      if (!ctx.player) socket.close(CloseCode.JOIN_TIMEOUT, 'join-timeout');
    }, config.joinTimeoutMs);

    socket.on('pong', () => (ctx.missedPongs = 0));

    socket.on('message', (data, isBinary) => {
      stats.bytesIn += data.length ?? data.byteLength;
      const limited = (bucket) => {
        if (bucket.take()) return false;
        stats.reject('rate-limit');
        socket.close(CloseCode.RATE_LIMIT, 'rate-limit');
        return true;
      };

      // Binary frames carry exactly one thing: an input packet.
      if (isBinary) {
        if (!ctx.player) return reject(socket, 'must-join-first', stats);
        if (limited(ctx.inputBucket)) return;
        let packet;
        try {
          if (data[0] !== BinType.INPUT) throw new CodecError('wrong-type');
          packet = codecs.binary.decodeInputPacket(data);
        } catch (err) {
          return reject(socket, err instanceof CodecError ? `bad-input:${err.message}` : 'bad-input', stats);
        }
        return ctx.netsim.deliver('in', () => ctx.match.input(ctx.player.id, packet));
      }

      // Text frames: parse (maxPayload already caps the cost), THEN pick the bucket by type.
      const res = validate(data);
      if (!res.ok) return reject(socket, res.reason, stats);
      const msg = res.msg;
      if (limited(msg.type === 'input' ? ctx.inputBucket : ctx.bucket)) return;

      if (msg.type === 'join') {
        if (ctx.player) return reject(socket, 'already-joined', stats);
        const room = manager.get(msg.room);
        if (!room) return socket.close(CloseCode.NO_SUCH_ROOM, 'no-such-room');
        if (room.full) return socket.close(CloseCode.ROOM_FULL, 'room-full');
        clearTimeout(joinTimer);
        ctx.room = room;
        ctx.player = room.join(msg.name, socket);
        ctx.codec = msg.codec;
        ctx.match = matchFor(room);
        const p = ctx.match.addPlayer(ctx.player.id, msg.name, (snap) => {
          // snapshots are NOT critical: a client that cannot keep up gets fewer of them (it needs the NEWEST, not all)
          ctx.netsim.deliver('out', () => {
            const payload = codecs[ctx.codec].encodeSnapshot(snap);
            stats.bytesOut += payload.byteLength ?? payload.length;
            send(socket, payload, config, false);
          });
        });
        send(socket, out.welcome(ctx.player.id, room.toJSON(), {
          shipId: p.ship.id, tickRate: TICK_RATE, arena: ARENA, codec: ctx.codec, netsim: config.allowNetsim,
        }), config, true);
        broadcast(room, out.roster(room.roster()), config, true);
        return;
      }
      if (!ctx.player) return reject(socket, 'must-join-first', stats);
      if (msg.type === 'input') return ctx.netsim.deliver('in', () => ctx.match.input(ctx.player.id, msg.packet));
      if (msg.type === 'ping') return ctx.netsim.deliver('in', () => ctx.netsim.deliver('out', () => send(socket, out.pong(msg.t), config, false)));
      if (msg.type === 'netsim') {
        if (!config.allowNetsim) return send(socket, out.error('netsim-disabled'), config, false);
        ctx.netsim.set(msg);
        return;
      }
      if (msg.type === 'chat') {
        ctx.room.chat(ctx.player, msg.text);
        broadcast(ctx.room, out.chat(ctx.player.name, msg.text), config, false);
      }
    });

    socket.on('close', () => {
      clearTimeout(joinTimer);
      ctx.netsim.close(); // cancel packets still in flight
      stats.connections--;
      if (ctx.player) {
        ctx.match?.removePlayer(ctx.player.id);
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

/** ?lag=100&jitter=30&drop=2 on the WebSocket URL (only when ENABLE_NETSIM=1). */
function netsimFromUrl(url = '') {
  const q = new URL(url, 'http://x').searchParams;
  const params = validateNetsim({ lag: Number(q.get('lag') ?? 0), jitter: Number(q.get('jitter') ?? 0), drop: Number(q.get('drop') ?? 0) });
  return params ?? {};
}
