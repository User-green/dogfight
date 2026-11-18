import { Entity, Kind } from './entity.js';
import { Vector2 } from './vector.js';

const TWO_PI = Math.PI * 2;

/**
 * Projectile entity fired by ships or turrets.
 * Single-level inheritance from Entity.
 */
export class Bullet extends Entity {
  /**
   * @param {Object} options
   * @param {Vector2} options.pos Initial spawn position (at ship nose)
   * @param {Vector2} options.vel Velocity (inherited ship velocity + muzzle velocity)
   * @param {number} [options.ttl=1.2] Lifespan in seconds before despawn
   * @param {number} [options.shooterId=null] ID of the entity that fired this bullet
   */
  constructor({ pos, vel, ttl = 1.2, shooterId = null } = {}) {
    super({
      kind: Kind.BULLET,
      pos,
      vel,
      radius: 2, // 2-unit radius hitbox
      maxSpeed: Infinity, // Bullets cruise at their initial launch speed
    });

    this.ttl = ttl;
    this.shooterId = shooterId; // Prevents friendly-fire on self
  }

  /**
   * Update bullet position and decrement TTL.
   * @param {number} dt Time step in seconds
   * @param {{ width: number, height: number }} arena Arena dimensions
   */
  update(dt, arena) {
    super.update(dt, arena);

    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.alive = false;
    }
  }

  /**
   * Draw classic Asteroids bullet: a crisp glowing white point.
   * @param {CanvasRenderingContext2D} ctx
   */
  render(ctx) {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.radius, 0, TWO_PI);
    ctx.fill();
    ctx.restore();
  }
}
