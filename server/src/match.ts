// One Match per room: the authoritative simulation. Runs the SHARED sim at 30 Hz.
import { performance } from 'node:perf_hooks';
import { World } from 'shared/sim/world';
import { Ship } from 'shared/sim/ship';
import { Asteroid } from 'shared/sim/asteroid';
import { Pickup } from 'shared/sim/pickup';
import { Vector2 } from 'shared/sim/vector';
import { snapshotEntities } from 'shared/state';
import { toShipInput, type Input, type InputPacket, type Snapshot } from 'shared/protocol';
import type { ShipInput } from 'shared/sim/ship';
import { asSeq, type EntityId, type Seq } from 'shared/types';
import { ARENA, TICK_DT, TICK_MS, MAX_INPUT_BACKLOG } from 'shared/constants';
import { Kind } from 'shared/sim/entity';

const SAFE_RADIUS = 200;
const PICKUP_RESPAWN_S = 15;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface MatchOptions {
  /** size of the first wave */
  asteroids?: number;
  seed?: number;
  /** monotonic ms clock (injectable for tests) */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

/** Everything the server remembers about one connected player. */
export interface MatchPlayer {
  readonly id: string;
  readonly name: string;
  readonly ship: Ship;
  queue: Input[];
  lastQueuedSeq: number;
  /** last input seq the sim consumed: echoed to the client so it can reconcile */
  ack: Seq;
  last: Input | null;
  /** called once per tick with this player's snapshot */
  readonly send: (snapshot: Snapshot) => void;
}

export interface MatchStats {
  ticks: number;
  tickMs: number;
  tickMaxMs: number;
  jitterMs: number;
  jitterMaxMs: number;
  overruns: number;
  resyncs: number;
  inputsAccepted: number;
  inputsStale: number;
  inputsDropped: number;
  starved: number;
}

export class Match {
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  readonly clearTimer: (handle: TimerHandle) => void;
  readonly seed: number;
  readonly world: World;
  waveSize: number;
  readonly players = new Map<string, MatchPlayer>();
  timer: TimerHandle | null = null;
  nextAt = 0;
  pickupTimer = 0;
  readonly stats: MatchStats;

  constructor({ asteroids = 4, seed = (Math.random() * 2 ** 32) >>> 0, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }: MatchOptions = {}) {
    this.now = now;
    this.setTimer = setTimer; // injectable so tests can drive the clock
    this.clearTimer = clearTimer;
    this.seed = seed;
    this.world = new World({ seed });
    this.waveSize = asteroids;
    this.stats = { ticks: 0, tickMs: 0, tickMaxMs: 0, jitterMs: 0, jitterMaxMs: 0, overruns: 0, resyncs: 0, inputsAccepted: 0, inputsStale: 0, inputsDropped: 0, starved: 0 };
    this.#lastStart = 0;
    this.#spawnWave(asteroids);
    this.#spawnPickups();
  }

  #lastStart: number;

  #spawnWave(count: number): void {
    const w = this.world;
    for (let i = 0; i < count; i++) {
      let pos: Vector2;
      let tries = 0;
      do pos = new Vector2(w.rng() * ARENA.width, w.rng() * ARENA.height);
      while (tries++ < 30 && [...w.ofKind(Kind.SHIP)].some((s) => s.pos.sub(pos).length() < SAFE_RADIUS));
      w.spawn(new Asteroid({ pos, tier: 3, rng: w.rng }));
    }
  }

  #spawnPickups(): void {
    const w = this.world;
    const have = new Set([...w.ofKind(Kind.PICKUP)].map((p) => p.type));
    if (!have.has('SHIELD')) w.spawn(new Pickup({ pos: new Vector2(250, 250), type: 'SHIELD' }));
    if (!have.has('RAPID_FIRE')) w.spawn(new Pickup({ pos: new Vector2(750, 750), type: 'RAPID_FIRE' }));
  }

  addPlayer(playerId: string, name: string, send: (snapshot: Snapshot) => void): MatchPlayer {
    const ship = new Ship({ pos: this.world.randomSafeSpot(ARENA, SAFE_RADIUS) });
    ship.respawn(ship.pos); // spawn protection
    this.world.spawn(ship);
    const p: MatchPlayer = { id: playerId, name, ship, queue: [], lastQueuedSeq: 0, ack: asSeq(0), last: null, send };
    this.players.set(playerId, p);
    return p;
  }

  removePlayer(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p) return;
    this.players.delete(playerId);
    this.world.remove(p.ship.id);
  }

  /** Queue validated inputs (oldest first). Duplicates and old ones (redundancy!) are ignored by seq. */
  input(playerId: string, packet: InputPacket): void {
    const p = this.players.get(playerId);
    if (!p) return;
    for (const i of packet.inputs) {
      if (i.seq <= p.lastQueuedSeq) {
        this.stats.inputsStale++;
        continue;
      }
      p.lastQueuedSeq = i.seq;
      p.queue.push(i);
      this.stats.inputsAccepted++;
    }
    while (p.queue.length > MAX_INPUT_BACKLOG) {
      p.queue.shift(); // client is ahead of us: drop the oldest rather than fall further behind
      this.stats.inputsDropped++;
    }
  }

  /** One authoritative step: consume one input per player, step the world, broadcast a snapshot. */
  tickOnce(): void {
    const inputs = new Map<EntityId, ShipInput>();
    for (const p of this.players.values()) {
      const next = p.queue.shift();
      let input: ShipInput;
      if (next) {
        p.last = next;
        p.ack = next.seq; // lastProcessedSeq
        input = toShipInput(next);
      } else if (p.last) {
        input = { ...toShipInput(p.last), fire: false, seq: undefined }; // no new input: keep holding keys, but never auto-fire
        this.stats.starved++;
      } else {
        input = { thrust: false, fire: false };
      }
      inputs.set(p.ship.id, input);
    }

    this.world.step(TICK_DT, ARENA, inputs);

    let asteroids = 0;
    for (const _ of this.world.ofKind(Kind.ASTEROID)) asteroids++;
    if (asteroids === 0) {
      this.waveSize += 2;
      this.#spawnWave(this.waveSize);
    }
    let pickups = 0;
    for (const _ of this.world.ofKind(Kind.PICKUP)) pickups++;
    if (pickups < 2) {
      this.pickupTimer += TICK_DT;
      if (this.pickupTimer >= PICKUP_RESPAWN_S) {
        this.pickupTimer = 0;
        this.#spawnPickups();
      }
    }

    const ents = snapshotEntities(this.world);
    const tick = this.world.tick;
    for (const p of this.players.values()) p.send({ tick, ack: p.ack, ents });
  }

  // ---- the timer ---------------------------------------------------------------------------------
  // setInterval(tick, 33) drifts (each callback fires late and the lateness accumulates) and coalesces.
  // Instead, every tick has an ABSOLUTE target time (start + n*33.33); we sleep until the next target,
  // so lateness never accumulates. If we fall more than 5 ticks behind, we resync instead of spiralling.
  start(): void {
    if (this.timer) return;
    this.nextAt = this.now() + TICK_MS;
    this.#lastStart = 0;
    this.#schedule();
  }

  stop(): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  #schedule(): void {
    this.timer = this.setTimer(() => this.#run(), Math.max(0, this.nextAt - this.now()));
  }

  #run(): void {
    const t0 = this.now();
    const s = this.stats;
    if (this.#lastStart) {
      const dev = Math.abs(t0 - this.#lastStart - TICK_MS); // how far this interval was from 33.33 ms
      s.jitterMs += (dev - s.jitterMs) * 0.05;
      s.jitterMaxMs = Math.max(s.jitterMaxMs, dev);
    }
    this.#lastStart = t0;
    try {
      this.tickOnce();
    } catch (err) {
      console.error('match tick failed:', err); // a bug in one room must not kill the others
    }
    const dur = this.now() - t0;
    s.ticks++;
    s.tickMs += (dur - s.tickMs) * 0.05;
    s.tickMaxMs = Math.max(s.tickMaxMs, dur);
    if (dur > TICK_MS) s.overruns++;
    this.nextAt += TICK_MS;
    if (this.now() > this.nextAt + 5 * TICK_MS) {
      s.resyncs++;
      this.nextAt = this.now() + TICK_MS;
    }
    this.#schedule();
  }

  snapshotStats(): MatchStats & { players: number; entities: number } {
    const r = (x: number): number => Math.round(x * 1000) / 1000;
    const s = this.stats;
    return { ...s, tickMs: r(s.tickMs), tickMaxMs: r(s.tickMaxMs), jitterMs: r(s.jitterMs), jitterMaxMs: r(s.jitterMaxMs), players: this.players.size, entities: this.world.size };
  }
}
