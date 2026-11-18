// GameClient: everything the netcode needs on the client, with NO DOM and NO WebSocket inside, so it can be
// unit-tested in Node against a real server Match. main.js wires it to the socket and the canvas.
//
//  - step()      once per fixed 30 Hz sim step: build an input, PREDICT it locally, send the last 3 inputs.
//  - onSnapshot  RECONCILE: take the server's state, drop acknowledged inputs, replay the rest, smooth the jump.
//  - frame()     INTERPOLATE other entities ~100 ms in the past; draw the local ship from the prediction.
import { TICK_DT, TICK_MS, INPUT_REDUNDANCY } from 'shared/constants';
import { Ship } from 'shared/sim/ship';
import type { Bullet } from 'shared/sim/bullet';
import { Kind } from 'shared/sim/entity';
import { toShipInput } from 'shared/protocol';
import type { Codec, InputPacket, ShipState, Snapshot, EntityState } from 'shared/protocol';
import { applyState, createFromState, entityState, wrapDelta, normAngle } from 'shared/state';
import type { ReplicatedEntity } from 'shared/state';
import { asSeq, asTick } from 'shared/types';
import type { Arena, EntityId, Seq, Tick } from 'shared/types';
import { TypedTarget } from '../typed-target.ts';
import type { InputState } from '../input.ts';

const MAX_PENDING = 120;
const TELEPORT = 60; // units between two snapshots above which an entity is considered to have teleported (respawn)
const HISTORY = 240;

const wrapPos = (v: number, size: number): number => ((v % size) + size) % size;
const angleDelta = (from: number, to: number): number => normAngle(to - from);

export interface ClientConfig {
  predict: boolean;
  reconcile: boolean;
  interpolate: boolean;
  interpDelayMs: number;
  smoothMs: number;
}

/** One input as it goes on the wire and into the pending list. */
export type InputCmd = InputPacket['inputs'][number];
interface Pose {
  x: number;
  y: number;
  a: number;
}
interface BufferedSnapshot {
  tick: Tick;
  at: number;
  ents: Map<EntityId, EntityState>;
}
/** My own predicted bullet: the shared Bullet plus the seq of the input that fired it (the Bullet already carries it as fireSeq). */
type PredictedBullet = Bullet;

export interface ClientMetrics {
  rttMs: number;
  rttLastMs: number;
  snapshots: number;
  snapshotsPerSec: number;
  bytesIn: number;
  bytesOut: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
  correction: number;
  correctionMax: number;
  corrections: { t: number; mag: number }[];
  starved: number;
  inputsSent: number;
  lastSnapshotAt: number;
  outOfOrder: number;
}

export interface NetgraphMetrics {
  rttMs: number;
  snapshotAgeMs: number;
  snapshotsPerSec: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
  pending: number;
  correction: number;
  correctionMax: number;
  interpDelayMs: number;
  starved: number;
  outOfOrder: number;
  history: { t: number; mag: number }[];
}

export interface GameClientOptions {
  /** id of my ship on the server */
  shipId: EntityId;
  arena: Arena;
  codec: Codec;
  /** transmit one input packet */
  send: (payload: string | ArrayBuffer) => void;
  /** ms clock */
  now?: () => number;
  config?: Partial<ClientConfig>;
}

export const defaultConfig = (): ClientConfig => ({
  predict: true, // apply my own inputs locally, immediately
  reconcile: true, // on a snapshot: replay unacknowledged inputs (off = snap back to the server state: rubber-banding)
  interpolate: true, // draw other entities between two buffered snapshots (off = draw the newest snapshot: 30 Hz stutter)
  interpDelayMs: 100, // how far in the past other entities are drawn (3 ticks)
  smoothMs: 100, // a correction fades out over about this long
});

export class GameClient extends TypedTarget<{ fired: void }> {
  readonly shipId: EntityId;
  readonly arena: Arena;
  readonly codec: Codec;
  readonly now: () => number;
  readonly sendPacket: (payload: string | ArrayBuffer) => void;
  config: ClientConfig;

  seq = 0;
  pending: InputCmd[] = []; // inputs applied locally but not yet acknowledged by the server
  ship: Ship | null = null; // predicted ship (a real Ship, driven by the shared sim)
  localView: Ship | null = null; // what is drawn for it
  prev: Pose | null = null; // before the latest step (render interpolation between 30 Hz steps)
  offset = { x: 0, y: 0 }; // visual correction, decays to 0
  predBullets: PredictedBullet[] = [];
  buffer: BufferedSnapshot[] = [];
  latest: BufferedSnapshot | null = null;
  clockOffset: number | null = null; // serverTimeMs - clientTimeMs
  proxies = new Map<EntityId, ReplicatedEntity>();
  lastFrameAt: number | null = null;
  m: ClientMetrics = {
    rttMs: 0, rttLastMs: 0, snapshots: 0, snapshotsPerSec: 0, bytesIn: 0, bytesOut: 0, bytesInPerSec: 0, bytesOutPerSec: 0,
    correction: 0, correctionMax: 0, corrections: [], starved: 0, inputsSent: 0, lastSnapshotAt: 0, outOfOrder: 0,
  };
  #win: { t: number; snaps: number; bin: number; bout: number };

  constructor({ shipId, arena, codec, send, now = () => performance.now(), config = {} }: GameClientOptions) {
    super();
    this.shipId = shipId;
    this.arena = arena;
    this.codec = codec;
    this.sendPacket = send;
    this.now = now;
    this.config = { ...defaultConfig(), ...config };
    this.#win = { t: this.now(), snaps: 0, bin: 0, bout: 0 };
  }

  // ---- sim step: prediction + input sending ---------------------------------------------------------
  step(keys: InputState): void {
    const input: InputCmd = {
      seq: asSeq(++this.seq),
      thrust: keys.thrust,
      turn: keys.rotateRight === keys.rotateLeft ? 0 : keys.rotateRight ? 1 : -1, // both keys down cancel out
      fire: keys.fire,
    };
    this.pending.push(input);
    if (this.pending.length > MAX_PENDING) this.pending.shift();

    if (this.config.predict && this.ship) {
      this.prev = { x: this.ship.pos.x, y: this.ship.pos.y, a: this.ship.angle };
      this.#advance(input, true);
    }
    for (const b of this.predBullets) b.update(TICK_DT, this.arena);
    this.predBullets = this.predBullets.filter((b) => b.alive);

    const inputs = this.pending.slice(-INPUT_REDUNDANCY).map(({ seq, thrust, turn, fire }) => ({ seq, thrust, turn, fire }));
    const payload = this.codec.encodeInputPacket({ tick: this.latest?.tick ?? asTick(0), inputs });
    this.m.bytesOut += typeof payload === 'string' ? payload.length : payload.byteLength;
    this.m.inputsSent++;
    this.sendPacket(payload);
  }

  /** The SAME computation the server does for one tick of one ship. Shared code, so no drift by construction. */
  #advance(input: InputCmd, spawnBullets: boolean): void {
    const s = this.ship;
    if (!s) return;
    s.step(TICK_DT, toShipInput(input), this.arena);
    if (!input.fire) return;
    const bullet = s.fire({ spawn: (b) => b }); // Ship.fire returns the bullet it spawned
    if (spawnBullets && bullet) {
      bullet.fireSeq = input.seq;
      bullet.update(TICK_DT, this.arena); // the server updates a bullet in the tick it is spawned (Map iteration sees it)
      this.predBullets.push(bullet);
      this.emit('fired', undefined);
    }
  }

  // ---- snapshots: reconciliation + buffering --------------------------------------------------------
  onSnapshot({ tick, ack, ents }: Snapshot, bytes = 0): void {
    const at = this.now();
    const m = this.m;
    m.bytesIn += bytes;
    if (this.latest && tick <= this.latest.tick) {
      m.outOfOrder++;
      return;
    }
    m.snapshots++;
    m.lastSnapshotAt = at;

    // server clock estimate: trust the least-delayed samples (a fast packet shows the true offset)
    const sample = tick * TICK_MS - at;
    if (this.clockOffset === null) this.clockOffset = sample;
    else this.clockOffset += (sample - this.clockOffset) * (sample > this.clockOffset ? 0.2 : 0.02);

    const map = new Map(ents.map((e) => [e.id, e]));
    const snap: BufferedSnapshot = { tick, at, ents: map };
    this.buffer.push(snap);
    while (this.buffer.length > 40 || (this.buffer.length > 2 && tick - (this.buffer[0]?.tick ?? tick) > 60)) this.buffer.shift();
    this.latest = snap;

    const mine = map.get(this.shipId);
    if (mine?.kind === Kind.SHIP) this.#reconcile(mine, ack);
    this.#reconcileBullets(map, ack);
  }

  #reconcile(server: ShipState, ack: Seq): void {
    this.pending = this.pending.filter((i) => i.seq > ack);
    if (!this.ship) {
      const ship = (this.ship = new Ship({ id: this.shipId }));
      this.localView = new Ship({ id: this.shipId });
      applyState(ship, server);
      this.prev = { x: server.x, y: server.y, a: server.a };
      return;
    }
    if (!this.config.predict) {
      applyState(this.ship, server);
      return;
    }
    const ship = this.ship;
    const before = { x: ship.pos.x, y: ship.pos.y };
    applyState(ship, server); // 1. authoritative state
    if (this.config.reconcile) {
      for (const i of this.pending) this.#advance(i, false); // 2+3. forget acknowledged inputs, replay the rest
    }
    const dx = wrapDelta(ship.pos.x, before.x, this.arena.width);
    const dy = wrapDelta(ship.pos.y, before.y, this.arena.height);
    const mag = Math.hypot(dx, dy);
    if (mag > TELEPORT) {
      this.offset.x = this.offset.y = 0; // respawn: a jump, not a correction to hide
      this.prev = { x: ship.pos.x, y: ship.pos.y, a: ship.angle };
    } else {
      this.offset.x += dx; // 4. show the OLD position, then fade into the new one
      this.offset.y += dy;
    }
    const mm = this.m;
    mm.correction = mag;
    mm.correctionMax = Math.max(mm.correctionMax, mag);
    mm.corrections.push({ t: this.now(), mag });
    if (mm.corrections.length > HISTORY) mm.corrections.shift();
  }

  #reconcileBullets(map: Map<EntityId, EntityState>, ack: Seq): void {
    if (!this.config.predict) {
      this.predBullets = [];
      return;
    }
    const mineFseqs = new Set<number>();
    for (const e of map.values()) if (e.kind === Kind.BULLET && e.shooter === this.shipId) mineFseqs.add(e.fseq);
    // (The old code also did `b.serverId = twin.id`. Nothing ever read serverId: TypeScript made that visible, it is gone.)
    this.predBullets = this.predBullets.filter((b) => b.fireSeq > ack /* the server has not seen that input yet: keep predicting */ || mineFseqs.has(b.fireSeq));
    // else: the server has no such bullet (hit something, or never fired): drop mine
  }

  // ---- ping -------------------------------------------------------------------------------------------
  pingPayload(): { type: 'ping'; t: number } {
    return { type: 'ping', t: this.now() };
  }

  onPong(t: number): void {
    const rtt = this.now() - t;
    this.m.rttLastMs = rtt;
    this.m.rttMs = this.m.rttMs === 0 ? rtt : this.m.rttMs * 0.8 + rtt * 0.2;
  }

  // ---- drawing ----------------------------------------------------------------------------------------
  /** Entities to draw this frame. `alpha` is the 0..1 fraction of the way to the next sim step (the loop's accumulator). */
  frame(alpha = 1): (ReplicatedEntity | Ship | Bullet)[] {
    const now = this.now();
    const dt = this.lastFrameAt === null ? 0 : now - this.lastFrameAt;
    this.lastFrameAt = now;
    this.#roll(now);

    const states = this.#remoteStates(now);
    const out: (ReplicatedEntity | Ship | Bullet)[] = [];
    const seen = new Set<EntityId>();
    const own = new Set(this.predBullets.map((b) => b.fireSeq));
    for (const s of states) {
      if (s.id === this.shipId && this.config.predict && this.ship) continue; // drawn from the prediction below
      if (this.config.predict && s.kind === Kind.BULLET && s.shooter === this.shipId && own.has(s.fseq)) continue; // I draw my own prediction
      let p = this.proxies.get(s.id);
      if (!p) this.proxies.set(s.id, (p = createFromState(s)));
      applyState(p, s);
      seen.add(s.id);
      out.push(p);
    }
    for (const id of this.proxies.keys()) if (!seen.has(id)) this.proxies.delete(id);

    if (this.ship && this.localView && this.config.predict) {
      this.#decayOffset(dt);
      const cur = this.ship;
      const prev = this.prev ?? { x: cur.pos.x, y: cur.pos.y, a: cur.angle };
      const { width: W, height: H } = this.arena;
      const x = wrapPos(prev.x + wrapDelta(prev.x, cur.pos.x, W) * alpha + this.offset.x, W);
      const y = wrapPos(prev.y + wrapDelta(prev.y, cur.pos.y, H) * alpha + this.offset.y, H);
      const a = prev.a + angleDelta(prev.a, cur.angle) * alpha;
      const st = entityState(cur);
      if (st?.kind === Kind.SHIP) applyState(this.localView, { ...st, x, y, a });
      out.push(this.localView);
      for (const b of this.predBullets) out.push(b);
    }
    return out;
  }

  #decayOffset(dt: number): void {
    const k = Math.exp((-3 * dt) / this.config.smoothMs);
    this.offset.x *= k;
    this.offset.y *= k;
    if (Math.abs(this.offset.x) < 0.01) this.offset.x = 0;
    if (Math.abs(this.offset.y) < 0.01) this.offset.y = 0;
  }

  /** Interpolated (or newest) state of every entity, as plain states. */
  #remoteStates(now: number): EntityState[] {
    const first = this.buffer[0];
    const last = this.buffer.at(-1);
    if (!first || !last) return [];
    if (!this.config.interpolate) return [...last.ents.values()];

    const T = now + (this.clockOffset ?? 0) - this.config.interpDelayMs;
    if (T <= first.tick * TICK_MS) return [...first.ents.values()];
    if (T >= last.tick * TICK_MS) {
      this.m.starved++; // the buffer ran dry: hold the newest snapshot (no extrapolation)
      return [...last.ents.values()];
    }
    let i = this.buffer.length - 2;
    while (i > 0 && (this.buffer[i]?.tick ?? 0) * TICK_MS > T) i--;
    const A = this.buffer[i];
    const B = this.buffer[i + 1];
    if (!A || !B) return [...last.ents.values()];
    const f = (T - A.tick * TICK_MS) / ((B.tick - A.tick) * TICK_MS);
    const { width: W, height: H } = this.arena;
    const out: EntityState[] = [];
    for (const a of A.ents.values()) {
      const b = B.ents.get(a.id);
      if (!b) {
        out.push(a); // despawned in B: hold its last position until the bracket moves on
        continue;
      }
      const dx = wrapDelta(a.x, b.x, W);
      const dy = wrapDelta(a.y, b.y, H);
      if (Math.hypot(dx, dy) > TELEPORT) {
        out.push(a); // respawn: no tween across the arena
        continue;
      }
      const x = wrapPos(a.x + dx * f, W);
      const y = wrapPos(a.y + dy * f, H);
      // Only ships and asteroids have a heading; the kind checks narrow `a` and `b` so the angle is read type-safely.
      if ((a.kind === Kind.SHIP && b.kind === Kind.SHIP) || (a.kind === Kind.ASTEROID && b.kind === Kind.ASTEROID)) {
        out.push({ ...b, x, y, a: a.a + angleDelta(a.a, b.a) * f });
      } else {
        out.push({ ...b, x, y });
      }
    }
    // entities only in B appeared after T: they are not drawn yet
    return out;
  }

  // ---- metrics ----------------------------------------------------------------------------------------
  #roll(now: number): void {
    const w = this.#win;
    if (now - w.t < 1000) return;
    const sec = (now - w.t) / 1000;
    this.m.snapshotsPerSec = (this.m.snapshots - w.snaps) / sec;
    this.m.bytesInPerSec = (this.m.bytesIn - w.bin) / sec;
    this.m.bytesOutPerSec = (this.m.bytesOut - w.bout) / sec;
    Object.assign(w, { t: now, snaps: this.m.snapshots, bin: this.m.bytesIn, bout: this.m.bytesOut });
  }

  /** Numbers for the netgraph. */
  metrics(): NetgraphMetrics {
    const now = this.now();
    this.#roll(now);
    const m = this.m;
    return {
      rttMs: m.rttMs,
      snapshotAgeMs: m.lastSnapshotAt ? now - m.lastSnapshotAt : 0,
      snapshotsPerSec: m.snapshotsPerSec,
      bytesInPerSec: m.bytesInPerSec,
      bytesOutPerSec: m.bytesOutPerSec,
      pending: this.pending.length,
      correction: m.correction,
      correctionMax: m.correctionMax,
      interpDelayMs: this.config.interpDelayMs,
      starved: m.starved,
      outOfOrder: m.outOfOrder,
      history: m.corrections,
    };
  }
}
