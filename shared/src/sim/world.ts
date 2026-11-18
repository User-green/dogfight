import { Kind } from './entity.ts';
import type { Entity } from './entity.ts';
import type { Ship, ShipInput } from './ship.ts';
import type { Bullet } from './bullet.ts';
import type { Asteroid } from './asteroid.ts';
import type { Pickup } from './pickup.ts';
import type { Explosion } from './explosion.ts';
import type { Arena, EntityId, Rng, Tick } from '../types.ts';
import { asEntityId, asTick } from '../types.ts';

/** Every concrete entity class. `kind` is a distinct literal in each, so checking `e.kind` narrows the union. */
export type AnyEntity = Ship | Bullet | Asteroid | Pickup | Explosion;

const NO_INPUT: ShipInput = Object.freeze({});
import { resolveCollisions } from './collision.ts';
import { Vector2 } from './vector.ts';
import { mulberry32 } from '../rng.ts';

const RESPAWN_SECONDS = 2.0;

/**
 * World: The central entity manager.
 * Stores entities in a Map<number, Entity> for O(1) lookups and safe iteration.
 * Implements deferred despawn sweeping to prevent iterator invalidation bugs.
 */
export class World {
  /** @type {Map<number, import('./entity.ts').Entity>} */
  #entities = new Map<EntityId, AnyEntity>();

  /** @type {number[]} IDs marked for deferred deletion at the end of the tick */
  #deadList: EntityId[] = [];

  /** Per-world id counter: two worlds fed the same seed and inputs hand out the same ids. */
  #nextId = 1;

  /** Event bus: the sim dispatches, UI/audio subscribe. The sim imports neither. */
  bus = new EventTarget();

  score = 0;
  tick: Tick = asTick(0);
  rng: Rng;

  /**
   */
  constructor({ seed = 1 }: { seed?: number } = {}) {
    this.rng = mulberry32(seed);
  }

  emit(type: string, detail: object = {}): void {
    this.bus.dispatchEvent(new CustomEvent(type, { detail }));
  }

  addScore(delta: number, shipId?: EntityId | null): void {
    this.score += delta;
    const ship = shipId === undefined || shipId === null ? undefined : this.#entities.get(shipId);
    if (ship?.kind === Kind.SHIP) ship.score += delta;
    this.emit('scoreChanged', { score: this.score, delta });
  }

  /**
   * Spawn a new entity into the world.
   */
  spawn<T extends AnyEntity>(entity: T): T {
    if (entity.id === 0) entity.assignId(asEntityId(this.#nextId++));
    this.#entities.set(entity.id, entity);
    return entity;
  }

  /** Remove an entity immediately. Only call between ticks (a player left), never while iterating. */
  remove(id: EntityId): void {
    this.#entities.delete(id);
  }

  /**
   * Mark an entity for deferred despawn.
   * Does NOT mutate the Map immediately to prevent iterator invalidation bugs.
   */
  despawn(id: EntityId): void {
    const entity = this.#entities.get(id);
    if (entity && entity.alive) {
      entity.alive = false;
      this.#deadList.push(id);
    }
  }

  /**
   * Look up an entity by its unique ID.
   */
  get(id: EntityId): AnyEntity | undefined {
    return this.#entities.get(id);
  }

  /**
   * Number of active entities currently in the world.
   */
  get size(): number {
    return this.#entities.size;
  }

  /**
   * Makes World directly iterable via for...of:
   * for (const entity of world) { ... }
   */
  *[Symbol.iterator](): Generator<AnyEntity> {
    yield* this.#entities.values();
  }

  /**
   * Generator to filter entities by kind without allocating an intermediate array.
   * Example: for (const bullet of world.ofKind(Kind.BULLET)) { ... }
   */
  *ofKind<K extends AnyEntity['kind']>(kind: K): Generator<Extract<AnyEntity, { kind: K }>> {
    for (const entity of this.#entities.values()) {
      if (entity.kind === kind && entity.alive) {
        yield entity as Extract<AnyEntity, { kind: K }>; // TS cannot narrow a union by a generic discriminant
      }
    }
  }

  /**
   * O(k) deferred sweep: removes only entities that died during this tick.
   */
  sweep(): void {
    // 1. Process explicit despawn queue
    for (const id of this.#deadList) this.#entities.delete(id);
    this.#deadList.length = 0;

    // 2. Safety pass: also prune any entity whose alive flag was flipped to false (e.g. TTL expiry)
    for (const [id, entity] of this.#entities) {
      // The ship is kept so World.step can respawn it after the timer
      if (!entity.alive && entity.kind !== Kind.SHIP) {
        this.#entities.delete(id);
      }
    }
  }

  /**
   * Advance the simulation by dt.
   * 1. Updates all entities (each ship gets ITS OWN input; a ship fires if its input says so).
   * 2. Resolves circle-circle collisions.
   * 3. Counts down each dead ship's respawn timer.
   * 4. Runs deferred despawn sweep (O(k)).
   */
  step(dt: number, arena: Arena, inputs: ReadonlyMap<EntityId, ShipInput> | ShipInput = NO_INPUT): void {
    const ships: Ship[] = [];

    // 1. Update entities
    for (const entity of this.#entities.values()) {
      // Remember ships even while dead, so the respawn step below can find them
      if (entity.kind === Kind.SHIP) ships.push(entity);
      if (!entity.alive) continue;

      // Composition: update homing behavior if attached to any entity (bullet, asteroid, etc.)
      if (entity.homing) {
        entity.homing.update(entity, dt);
      }

      if (entity.kind === Kind.SHIP) {
        const input = inputs instanceof Map ? (inputs.get(entity.id) ?? NO_INPUT) : inputs;
        entity.step(dt, input, arena);
        if (input.fire) {
          const bullet = entity.fire(this);
          if (bullet && input.seq !== undefined) bullet.fireSeq = input.seq; // lets the shooter match its predicted bullet
        }
      } else {
        entity.update(dt, arena);
      }
    }

    // 2. Resolve collisions
    resolveCollisions(this, {
      onShipDestroyed: (ship) => {
        ship.respawnTimer = RESPAWN_SECONDS;
      },
    });

    // 3. Handle respawns
    for (const ship of ships) {
      if (!ship.alive && ship.respawnTimer > 0) {
        ship.respawnTimer -= dt;
        if (ship.respawnTimer <= 0) ship.respawn(this.randomSafeSpot(arena, 200));
      }
    }

    // 4. Sweep dead entities (O(k))
    this.sweep();
    this.tick = asTick(this.tick + 1);
  }

  /**
   * Random point at least `minDist` away from every living asteroid.
   * Falls back to the arena centre after 50 failed tries.
   */
  randomSafeSpot(arena: Arena, minDist: number): Vector2 {
    for (let attempt = 0; attempt < 50; attempt++) {
      const p = new Vector2(this.rng() * arena.width, this.rng() * arena.height);
      let safe = true;
      for (const a of this.ofKind(Kind.ASTEROID)) {
        if (a.pos.sub(p).length() < minDist) {
          safe = false;
          break;
        }
      }
      if (safe) return p;
    }
    return new Vector2(arena.width / 2, arena.height / 2);
  }

  /**
   * Render all living entities.
   */
  render(ctx: CanvasRenderingContext2D, draw: (c: CanvasRenderingContext2D, e: Entity) => void = (c, e) => e.render(c)): void {
    for (const entity of this.#entities.values()) {
      if (entity.alive) {
        draw(ctx, entity);
      }
    }
  }
}
