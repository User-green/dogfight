import { Kind } from './entity.js';
import { resolveCollisions } from './collision.js';
import { Vector2 } from './vector.js';
import { mulberry32 } from '../rng.js';

const NO_INPUT = Object.freeze({});
const RESPAWN_SECONDS = 2.0;

/**
 * World: The central entity manager.
 * Stores entities in a Map<number, Entity> for O(1) lookups and safe iteration.
 * Implements deferred despawn sweeping to prevent iterator invalidation bugs.
 */
export class World {
  /** @type {Map<number, import('./entity.js').Entity>} */
  #entities = new Map();

  /** @type {number[]} IDs marked for deferred deletion at the end of the tick */
  #deadList = [];

  /** Per-world id counter: two worlds fed the same seed and inputs hand out the same ids. */
  #nextId = 1;

  /** Event bus: the sim dispatches, UI/audio subscribe. The sim imports neither. */
  bus = new EventTarget();

  /**
   * @param {Object} [options]
   * @param {number} [options.seed=1] Seed for the world's PRNG: the ONLY source of randomness in the sim.
   */
  constructor({ seed = 1 } = {}) {
    this.score = 0;
    this.tick = 0;
    this.rng = mulberry32(seed);
  }

  emit(type, detail = {}) {
    this.bus.dispatchEvent(new CustomEvent(type, { detail }));
  }

  addScore(delta, shipId) {
    this.score += delta;
    const ship = shipId === undefined ? undefined : this.#entities.get(shipId);
    if (ship?.kind === Kind.SHIP) ship.score += delta;
    this.emit('scoreChanged', { score: this.score, delta });
  }

  /**
   * Spawn a new entity into the world.
   * @param {import('./entity.js').Entity} entity
   * @returns {import('./entity.js').Entity}
   */
  spawn(entity) {
    if (entity.id === 0) entity.assignId(this.#nextId++);
    this.#entities.set(entity.id, entity);
    return entity;
  }

  /** Remove an entity immediately. Only call between ticks (a player left), never while iterating. */
  remove(id) {
    this.#entities.delete(id);
  }

  /**
   * Mark an entity for deferred despawn.
   * Does NOT mutate the Map immediately to prevent iterator invalidation bugs.
   * @param {number} id
   */
  despawn(id) {
    const entity = this.#entities.get(id);
    if (entity && entity.alive) {
      entity.alive = false;
      this.#deadList.push(id);
    }
  }

  /**
   * Look up an entity by its unique ID.
   * @param {number} id
   * @returns {import('./entity.js').Entity|undefined}
   */
  get(id) {
    return this.#entities.get(id);
  }

  /**
   * Number of active entities currently in the world.
   * @returns {number}
   */
  get size() {
    return this.#entities.size;
  }

  /**
   * Makes World directly iterable via for...of:
   * for (const entity of world) { ... }
   */
  *[Symbol.iterator]() {
    yield* this.#entities.values();
  }

  /**
   * Generator to filter entities by kind without allocating an intermediate array.
   * Example: for (const bullet of world.ofKind(Kind.BULLET)) { ... }
   * @param {number} kind
   */
  *ofKind(kind) {
    for (const entity of this.#entities.values()) {
      if (entity.kind === kind && entity.alive) {
        yield entity;
      }
    }
  }

  /**
   * O(k) deferred sweep: removes only entities that died during this tick.
   */
  sweep() {
    // 1. Process explicit despawn queue
    for (let i = 0; i < this.#deadList.length; i++) {
      this.#entities.delete(this.#deadList[i]);
    }
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
   * @param {number} dt Delta time in seconds
   * @param {{ width: number, height: number }} arena Dimensions
   * @param {Map<number, Object>|Object} [inputs] Map shipId -> input, or ONE input applied to every ship
   */
  step(dt, arena, inputs = NO_INPUT) {
    const perShip = inputs instanceof Map;
    const ships = [];

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
        const input = perShip ? (inputs.get(entity.id) ?? NO_INPUT) : inputs;
        entity.update(dt, input, arena);
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
    this.tick++;
  }

  /**
   * Random point at least `minDist` away from every living asteroid.
   * Falls back to the arena centre after 50 failed tries.
   */
  randomSafeSpot(arena, minDist) {
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
   * @param {CanvasRenderingContext2D} ctx
   */
  render(ctx, draw = (c, e) => e.render(c)) {
    for (const entity of this.#entities.values()) {
      if (entity.alive) {
        draw(ctx, entity);
      }
    }
  }
}
