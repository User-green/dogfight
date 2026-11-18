// A virtual-time network between a real server Match and a real GameClient. Deterministic and fast:
// no sockets, no sleeping; packets go through the real codec, so quantization is included.
import { Match } from '../../server/src/match.js';
import { GameClient } from '../src/net/gameclient.js';
import { codecs } from 'shared/codec/index';
import { mulberry32 } from 'shared/rng';
import { ARENA, TICK_MS } from 'shared/constants';

const NO_KEYS = { thrust: false, rotateLeft: false, rotateRight: false, fire: false };

/** The scripted pilot: thrust in bursts, weave left/right, fire now and then. */
export const pilot = (tick, k = 0) => ({
  thrust: (tick + k * 20) % 90 < 60,
  rotateLeft: Math.floor((tick + k * 7) / 25) % 3 === 1,
  rotateRight: Math.floor((tick + k * 7) / 25) % 3 === 2,
  fire: (tick + k * 3) % 11 === 0,
});

export function simulate({
  seconds = 12, lag = 100, jitter = 0, drop = 0, asteroids = 0, codec = 'binary', config = {}, seed = 3,
  keys = pilot, withRival = false, framesPerStep = 2, onFrame, clientPhaseMs = 7,
} = {}) {
  const rng = mulberry32(seed + 1000);
  const match = new Match({ asteroids, seed });
  let clock = 0;
  const wire = codecs[codec];

  const toServer = []; // {due, payload}
  const toClient = [];
  const oneWay = () => Math.max(0, lag / 2 + (rng() * 2 - 1) * (jitter / 2));
  const lanes = { c2s: 0, s2c: 0 };
  const push = (queue, lane, payload) => {
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
    while (toServer.length && toServer[0].due <= clock) match.input('me', wire.decodeInputPacket(toServer.shift().payload));
    while (toClient.length && toClient[0].due <= clock) {
      const { payload } = toClient.shift();
      client.onSnapshot(wire.decodeSnapshot(payload), payload.byteLength ?? payload.length);
    }
    if (clock >= nextServer) {
      if (rival) {
        const k = pilot(result.serverTicks, 3);
        match.input('rival', { tick: 0, inputs: [{ seq: ++rivalSeq, thrust: k.thrust, turn: (k.rotateRight ? 1 : 0) - (k.rotateLeft ? 1 : 0), fire: k.fire }] });
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

export function stats(values) {
  if (!values.length) return { n: 0, mean: 0, p95: 0, max: 0 };
  const v = [...values].sort((a, b) => a - b);
  return { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, p95: v[Math.floor(v.length * 0.95)], max: v.at(-1) };
}

/** Correction magnitudes after a warm-up. */
export const correctionStats = (client, afterMs = 2000) => stats(client.m.corrections.filter((c) => c.t > afterMs).map((c) => c.mag));
