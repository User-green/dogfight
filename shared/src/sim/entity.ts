import { Vector2 } from './vector.ts';
import { NO_ID } from '../types.ts';
import type { Arena, EntityId } from '../types.ts';
import type { HomingBehavior } from './homing.ts';

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
} as const);

/** Union of the literal kind numbers: 0 | 1 | 2 | 3 | 4 | 5. A `switch (e.kind)` over it can be checked for exhaustiveness. */
export type KindValue = (typeof Kind)[keyof typeof Kind];

export interface EntityOptions {
  kind?: KindValue;
  pos?: Vector2;
  vel?: Vector2;
  angle?: number;
  radius?: number;
  maxSpeed?: number;
  /** Explicit id (a client mirroring a server entity); default: assigned by World.spawn */
  id?: EntityId;
}

/**
 * Base Entity class.
 * All arena objects (Ship, Bullet, Asteroid, etc.) inherit from this class (1 level deep).
 */
export class Entity {
  /** Private entity ID; NO_ID (0) = not assigned yet. The WORLD assigns ids (a global counter would leak state between worlds/runs). */
  #id: EntityId = NO_ID;

  kind: KindValue;
  pos: Vector2;
  vel: Vector2;
  angle: number;
  radius: number;
  maxSpeed: number;
  alive: boolean;
  /** Optional composed behaviour (Lab 2): any entity may steer toward a target. */
  homing?: HomingBehavior;

  /**
   */
  constructor({
    kind = Kind.UNKNOWN,
    pos = new Vector2(0, 0),
    vel = new Vector2(0, 0),
    angle = 0,
    radius = 10,
    maxSpeed = Infinity,
    id,
  }: EntityOptions = {}) {
    if (id !== undefined) this.#id = id;
    this.kind = kind;
    this.pos = pos;
    this.vel = vel;
    this.angle = angle;
    this.radius = radius;
    this.maxSpeed = maxSpeed;
    this.alive = true;
  }

  /** Called once by World.spawn. */
  assignId(id: EntityId): void {
    if (this.#id !== NO_ID) throw new Error(`entity already has id ${this.#id}`);
    this.#id = id;
  }

  /**
   * Public getter for the private entity ID.
   */
  get id(): EntityId {
    return this.#id;
  }

  /**
   * Integrate motion and enforce boundaries.
   * Uses in-place math to avoid GC pressure at 60Hz.
   */
  update(dt: number, arena?: Arena): void {
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
   */
  wrap(arena: Arena): void {
    const { width, height } = arena;
    if (this.pos.x < 0) this.pos.x += width;
    else if (this.pos.x >= width) this.pos.x -= width;

    if (this.pos.y < 0) this.pos.y += height;
    else if (this.pos.y >= height) this.pos.y -= height;
  }

  /**
   * Base render method to be overridden by subclasses.
   */
  render(ctx: CanvasRenderingContext2D): void {
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
