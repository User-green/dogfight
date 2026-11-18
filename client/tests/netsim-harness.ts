// A virtual-time network between a real server Match and a real GameClient. Deterministic and fast:
// no sockets, no sleeping; packets go through the real codec, so quantization is included.
import { Match } from '../../server/src/match.ts';
import { GameClient } from '../src/net/gameclient.ts';
import type { ClientConfig } from '../src/net/gameclient.ts';
import type { InputState } from '../src/input.ts';
import { asSeq, asTick } from 'shared/types';
import { codecs } from 'shared/codec/index';
import { mulberry32 } from 'shared/rng';
import { ARENA, TICK_MS } from 'shared/constants';

const NO_KEYS = { thrust: false, rotateLeft: false, rotateRight: false, fire: false };

/** The scripted pilot: thrust in bursts, weave left/right, fire now and then. */
export const pilot = (tick: number, k = 0): InputState => ({
  thrust: (tick + k * 20) % 90 < 60,
  rotateLeft: Math.floor((tick + k * 7) / 25) % 3 === 1,
  rotateRight: Math.floor((tick + k * 7) / 25) % 3 === 2,
  fire: (tick + k * 3) % 11 === 0,
});

export interface FrameInfo {
  clock: number;
  entities: ReturnType<GameClient['frame']>;
  client: GameClient;
  match: Match;
  me: ReturnType<Match['addPlayer']>;
  rival: ReturnType<Match['addPlayer']> | null;
}

export interface SimOptions {
  seconds?: number;
  lag?: number;
  jitter?: number;
  drop?: number;
  asteroids?: number;
  codec?: keyof typeof codecs;
  config?: Partial<ClientConfig>;
  seed?: number;
  keys?: (tick: number) => InputState;
  withRival?: boolean;
  framesPerStep?: number;
  onFrame?: (f: FrameInfo) => void;
  clientPhaseMs?: number;
}

interface InFlight<T> {
  due: number;
  payload: T;
}

export function simulate({
  seconds = 12, lag = 100, jitter = 0, drop = 0, asteroids = 0, codec = 'binary', config = {}, seed = 3,
  keys = pilot, withRival = false, onFrame, clientPhaseMs = 7,
}: SimOptions = {}) {
  const rng = mulberry32(seed + 1000);
  const match = new Match({ asteroids, seed });
  let clock = 0;
  const wire = codecs[codec];

  const toServer: InFlight<string | ArrayBuffer>[] = [];
  const toClient: InFlight<string | ArrayBuffer>[] = [];
  const oneWay = () => Math.max(0, lag / 2 + (rng() * 2 - 1) * (jitter / 2));
  const lanes = { c2s: 0, s2c: 0 };
  const push = (queue: InFlight<string | ArrayBuffer>[], lane: keyof typeof lanes, payload: string | ArrayBuffer): void => {
    if (rng() * 100 < drop) return;
    const due = Math.max(lanes[lane], clock + oneWay());
    lanes[lane] = due;
    queue.push({ due, payload });
  };

  const me = match.addPlayer('me', 'Me', (snap) => push(toClient, 's2c', wire.encodeSnapshot(snap)));
  let rival = null;
  if (withRival) rival = match.addPlayer('rival', 'Rival', () => {});

  const client = new GameClient({ shipId: me.ship.id, arena: ARENA, codec: wire, send: (p) => push(toServer, 'c2s', p), now: () => clock, config });

  const result = { client, match, me, rival, frames: 0, serverTicks: 0, truth: [] };
  const end = seconds * 1000;
  let nextServer = TICK_MS;
  let nextClient = TICK_MS + clientPhaseMs;
  let rivalSeq = 0;
  let clientTick = 0;
  let frameAcc = 0;

  for (clock = 0; clock <= end; clock += 1) {
    for (let p = toServer[0]; p && p.due <= clock; p = toServer[0]) {
      toServer.shift();
      match.input('me', wire.decodeInputPacket(p.payload));
    }
    for (let p = toClient[0]; p && p.due <= clock; p = toClient[0]) {
      toClient.shift();
      client.onSnapshot(wire.decodeSnapshot(p.payload), typeof p.payload === 'string' ? p.payload.length : p.payload.byteLength);
    }
    if (clock >= nextServer) {
      if (rival) {
        const k = pilot(result.serverTicks, 3);
        const turn = k.rotateRight === k.rotateLeft ? 0 : k.rotateRight ? 1 : -1;
        match.input('rival', { tick: asTick(0), inputs: [{ seq: asSeq(++rivalSeq), thrust: k.thrust, turn, fire: k.fire }] });
      }
      match.tickOnce();
      result.serverTicks++;
      nextServer += TICK_MS;
    }
    if (clock >= nextClient) {
      client.step(keys(clientTick++));
      nextClient += TICK_MS;
      frameAcc = 0;
    }
    // render frames (~60 per second)
    if (clock % 16 === 0) {
      const alpha = Math.min(1, Math.max(0, (clock - (nextClient - TICK_MS)) / TICK_MS));
      const entities = client.frame(alpha);
      result.frames++;
      onFrame?.({ clock, entities, client, match, me, rival });
    }
  }
  return result;
}

export function stats(values: number[]) {
  if (!values.length) return { n: 0, mean: 0, p95: 0, max: 0 };
  const v = [...values].sort((a, b) => a - b);
  return { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, p95: v[Math.floor(v.length * 0.95)] ?? 0, max: v.at(-1) ?? 0 };
}

/** Correction magnitudes after a warm-up. */
export const correctionStats = (client: GameClient, afterMs = 2000) => stats(client.m.corrections.filter((c) => c.t > afterMs).map((c) => c.mag));
