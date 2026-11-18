import { Vector2 } from './vector.js';

/**
 * Numeric enum for entity kinds.
 * Fast integer comparisons and compact representation.
 */
export const Kind = Object.freeze({
  UNKNOWN: 0,
  SHIP: 1,
  BULLET: 2,
  ASTEROID: 3,
  PICKUP: 4,
  EXPLOSION: 5,
});

/**
 * Base Entity class.
 * All arena objects (Ship, Bullet, Asteroid, etc.) inherit from this class (1 level deep).
 */
export class Entity {
  /** @type {number} Private static counter for auto-incrementing entity IDs */
  static #nextId = 1;

  /** @type {number} Private unique entity ID */
  #id = Entity.#nextId++;

  /**
   * @param {Object} options
   * @param {number} [options.kind=Kind.UNKNOWN]
   * @param {Vector2} [options.pos]
   * @param {Vector2} [options.vel]
   * @param {number} [options.angle=0] Facing angle in radians
   * @param {number} [options.radius=10] Collision radius in logical units
   * @param {number} [options.maxSpeed=Infinity] Maximum speed clamp
   */
  constructor({
    kind = Kind.UNKNOWN,
    pos = new Vector2(0, 0),
    vel = new Vector2(0, 0),
    angle = 0,
    radius = 10,
    maxSpeed = Infinity,
  } = {}) {
    this.kind = kind;
    this.pos = pos;
    this.vel = vel;
    this.angle = angle;
    this.radius = radius;
    this.maxSpeed = maxSpeed;
    this.alive = true;
  }

  /**
   * Public getter for the private entity ID.
   * @returns {number}
   */
  get id() {
    return this.#id;
  }

  /**
   * Integrate motion and enforce boundaries.
   * Uses in-place math to avoid GC pressure at 60Hz.
   * @param {number} dt Time step in seconds
   * @param {{ width: number, height: number }} arena Arena dimensions
   */
  update(dt, arena) {
    // 1. Clamp velocity to maxSpeed if needed
    if (this.maxSpeed < Infinity) {
      const speedSq = this.vel.lengthSq();
      const maxSpeedSq = this.maxSpeed * this.maxSpeed;
      if (speedSq > maxSpeedSq && speedSq > 0) {
        const factor = this.maxSpeed / Math.sqrt(speedSq);
        this.vel.scaleInPlace(factor);
      }
    }

    // 2. Integrate position: pos += vel * dt
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;

    // 3. Toroidal screen wrap (teleport smoothly across edges)
    if (arena) {
      this.wrap(arena);
    }
  }

  /**
   * Toroidal screen wrapping.
   * @param {{ width: number, height: number }} arena
   */
  wrap(arena) {
    const { width, height } = arena;
    if (this.pos.x < 0) this.pos.x += width;
    else if (this.pos.x >= width) this.pos.x -= width;

    if (this.pos.y < 0) this.pos.y += height;
    else if (this.pos.y >= height) this.pos.y -= height;
  }

  /**
   * Base render method to be overridden by subclasses.
   * @param {CanvasRenderingContext2D} ctx
   */
  render(ctx) {
    // Default debug representation: a subtle wireframe collision circle
    ctx.save();
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
