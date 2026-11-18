import { Entity, Kind } from './entity.ts';
import type { Vector2 } from './vector.ts';
import type { Arena, EntityId } from '../types.ts';

const TWO_PI = Math.PI * 2;

/**
 * Projectile entity fired by ships or turrets.
 * Single-level inheritance from Entity.
 */
export interface BulletOptions {
  pos: Vector2;
  vel: Vector2;
  ttl?: number;
  shooterId?: EntityId | null;
  id?: EntityId;
}

export class Bullet extends Entity {
  declare kind: typeof Kind.BULLET;
  ttl: number;
  /** Entity that fired this bullet; null when unknown. Prevents friendly fire on self. */
  shooterId: EntityId | null;
  /** seq of the input that fired it (0 = none) */
  fireSeq: number;

  /**
   */
  constructor({ pos, vel, ttl = 1.2, shooterId = null, id }: BulletOptions) {
    super({
      kind: Kind.BULLET,
      pos,
      vel,
      radius: 2, // 2-unit radius hitbox
      maxSpeed: Infinity, // Bullets cruise at their initial launch speed
      id,
    });

    this.ttl = ttl;
    this.shooterId = shooterId; // Prevents friendly-fire on self
    this.fireSeq = 0; // seq of the input that fired it (set by World.step); lets the shooter match its predicted bullet
  }

  /**
   * Update bullet position and decrement TTL.
   */
  override update(dt: number, arena?: Arena): void {
    super.update(dt, arena);

    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.alive = false;
    }
  }

  /**
   * Draw classic Asteroids bullet: a crisp glowing white point.
   */
  override render(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.radius, 0, TWO_PI);
    ctx.fill();
    ctx.restore();
  }
}
