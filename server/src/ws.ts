import type { IncomingMessage } from 'node:http';
import type { RawData, WebSocket, WebSocketServer } from 'ws';
import { codecs } from 'shared/codec/index';
import { BinType, CodecError, type CodecName } from 'shared/protocol';
import { TICK_RATE, ARENA } from 'shared/constants';
import { validate, out, CloseCode } from './protocol.ts';
import { TokenBucket } from './rate-limit.ts';
import { NetSim, validateNetsim, type NetsimParams } from './netsim.ts';
import type { ServerConfig } from './config.ts';
import type { Match } from './match.ts';
import type { Player, Room, RoomManager, SocketLike } from './rooms.ts';

/** Counters shared by the HTTP and WebSocket halves of the server (exposed on /api/stats). */
export interface ServerStats {
  connections: number;
  rejections: Record<string, number>;
  bytesIn: number;
  bytesOut: number;
  startedAt: number;
  reject(reason: string): void;
}

/** Everything the server remembers about ONE socket. `null` fields are the "has not joined yet" state. */
interface ConnectionContext {
  player: Player | null;
  room: Room | null;
  match: Match | null;
  missedPongs: number;
  readonly bucket: TokenBucket;
  readonly inputBucket: TokenBucket;
  codec: CodecName;
  readonly netsim: NetSim;
}

/** One Buffer whatever shape `ws` handed us (a fragmented message arrives as Buffer[]). */
function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return data;
}

const sizeOf = (payload: string | ArrayBuffer): number => (typeof payload === 'string' ? payload.length : payload.byteLength);

/**
 * Attach connection handling to a ws WebSocketServer.
 * Per-socket state lives in a WeakMap keyed by the socket: it is garbage-collected together with the socket.
 */
export function attachWs(wss: WebSocketServer, manager: RoomManager, config: ServerConfig, stats: ServerStats, matchFor: (room: Room) => Match): { heartbeat: NodeJS.Timeout } {
  const contexts = new WeakMap<WebSocket, ConnectionContext>();

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const ctx: ConnectionContext = {
      player: null,
      room: null,
      match: null,
      missedPongs: 0,
      bucket: new TokenBucket({ capacity: config.msgBurst, perSecond: config.msgPerSecond }),
      // inputs flow at 30/s, so they get their own (bigger) bucket: chat spam cannot starve input and vice versa
      inputBucket: new TokenBucket({ capacity: config.inputBurst, perSecond: config.inputPerSecond }),
      codec: 'json',
      netsim: new NetSim(config.allowNetsim ? netsimFromUrl(req.url) : {}),
    };
    contexts.set(socket, ctx);
    stats.connections++;

    // 'error' listener on EVERY socket: otherwise a socket error crashes the process.
    socket.on('error', (err: Error) => console.error('socket error:', err.message));

    const joinTimer = setTimeout(() => {
      if (!ctx.player) socket.close(CloseCode.JOIN_TIMEOUT, 'join-timeout');
    }, config.joinTimeoutMs);

    socket.on('pong', () => {
      ctx.missedPongs = 0;
    });

    socket.on('message', (raw: RawData, isBinary: boolean) => {
      const data = toBuffer(raw);
      stats.bytesIn += data.length;
      const limited = (bucket: TokenBucket): boolean => {
        if (bucket.take()) return false;
        stats.reject('rate-limit');
        socket.close(CloseCode.RATE_LIMIT, 'rate-limit');
        return true;
      };

      // Binary frames carry exactly one thing: an input packet.
      if (isBinary) {
        const { player, match } = ctx;
        if (!player || !match) return reject(socket, 'must-join-first', stats);
        if (limited(ctx.inputBucket)) return;
        let packet;
        try {
          if (data[0] !== BinType.INPUT) throw new CodecError('wrong-type');
          packet = codecs.binary.decodeInputPacket(data);
        } catch (err: unknown) {
          return reject(socket, err instanceof CodecError ? `bad-input:${err.message}` : 'bad-input', stats);
        }
        return ctx.netsim.deliver('in', () => match.input(player.id, packet));
      }

      // Text frames: parse (maxPayload already caps the cost), THEN pick the bucket by type.
      const res = validate(data);
      if (!res.ok) return reject(socket, res.error, stats);
      const msg = res.value;
      if (limited(msg.type === 'input' ? ctx.inputBucket : ctx.bucket)) return;

      if (msg.type === 'join') {
        if (ctx.player) return reject(socket, 'already-joined', stats);
        const room = manager.get(msg.room);
        if (!room) return socket.close(CloseCode.NO_SUCH_ROOM, 'no-such-room');
        if (room.full) return socket.close(CloseCode.ROOM_FULL, 'room-full');
        clearTimeout(joinTimer);
        const player = room.join(msg.name, socket);
        const match = matchFor(room);
        ctx.room = room;
        ctx.player = player;
        ctx.codec = msg.codec;
        ctx.match = match;
        const slot = match.addPlayer(player.id, msg.name, (snap) => {
          // snapshots are NOT critical: a client that cannot keep up gets fewer of them (it needs the NEWEST, not all)
          ctx.netsim.deliver('out', () => {
            const payload = codecs[ctx.codec].encodeSnapshot(snap);
            stats.bytesOut += sizeOf(payload);
            send(socket, payload, config, false);
          });
        });
        send(socket, out.welcome(player.id, room.toJSON(), {
          shipId: slot.ship.id, tickRate: TICK_RATE, arena: ARENA, codec: ctx.codec, netsim: config.allowNetsim,
        }), config, true);
        broadcast(room, out.roster(room.roster()), config, true);
        return;
      }

      const { player, room, match } = ctx;
      if (!player || !room || !match) return reject(socket, 'must-join-first', stats);
      switch (msg.type) {
        case 'input':
          return ctx.netsim.deliver('in', () => match.input(player.id, msg));
        case 'ping':
          return ctx.netsim.deliver('in', () => ctx.netsim.deliver('out', () => send(socket, out.pong(msg.t), config, false)));
        case 'netsim':
          if (!config.allowNetsim) return send(socket, out.error('netsim-disabled'), config, false);
          return ctx.netsim.set(msg);
        case 'chat':
          room.chat(player, msg.text);
          return broadcast(room, out.chat(player.name, msg.text), config, false);
      }
    });

    socket.on('close', () => {
      clearTimeout(joinTimer);
      ctx.netsim.close(); // cancel packets still in flight
      stats.connections--;
      const { player, room } = ctx;
      if (player && room) {
        ctx.match?.removePlayer(player.id);
        room.leave(player.id);
        broadcast(room, out.roster(room.roster()), config, true);
      }
    });
  });

  // Heartbeat: ping everyone; terminate sockets that missed two pongs (dead behind a NAT/proxy).
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const ctx = contexts.get(socket);
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

function reject(socket: SocketLike, reason: string, stats?: ServerStats): void {
  stats?.reject(reason);
  console.warn(`closing socket: ${reason}`);
  socket.close(CloseCode.BAD_PROTOCOL, reason);
}

/**
 * Slow-client policy: if the socket's outgoing buffer is above the threshold, drop
 * non-critical messages (chat); critical ones (roster/welcome) are still sent.
 * If even critical ones pile up to 4x the threshold, close the client.
 */
export function send(socket: SocketLike, payload: string | ArrayBuffer, config: Pick<ServerConfig, 'slowClientBytes'>, critical: boolean): void {
  if (socket.readyState !== socket.OPEN) return;
  const buffered = socket.bufferedAmount;
  if (buffered > config.slowClientBytes) {
    if (!critical) return;
    if (buffered > config.slowClientBytes * 4) return socket.close(CloseCode.SLOW_CLIENT, 'slow-client');
  }
  socket.send(payload);
}

export function broadcast(room: Room, payload: string | ArrayBuffer, config: Pick<ServerConfig, 'slowClientBytes'>, critical: boolean): void {
  for (const p of room.players.values()) send(p.socket, payload, config, critical);
}

/** ?lag=100&jitter=30&drop=2 on the WebSocket URL (only when ENABLE_NETSIM=1). */
function netsimFromUrl(url = ''): Partial<NetsimParams> {
  const q = new URL(url, 'http://x').searchParams;
  return validateNetsim({ lag: Number(q.get('lag') ?? 0), jitter: Number(q.get('jitter') ?? 0), drop: Number(q.get('drop') ?? 0) }) ?? {};
}
