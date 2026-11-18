import { Vector2 } from './vector.js';

/**
 * Homing behavior (Composition over Inheritance).
 * Can be attached to ANY entity (Bullet, Asteroid, etc.) without creating
 * a deep inheritance hierarchy (e.g. Entity -> Movable -> Homing -> HomingBullet).
 */
export class HomingBehavior {
  /**
   * @param {Object} options
   * @param {import('./entity.js').Entity|Function} options.target Target entity or function returning target
   * @param {number} [options.turnRate=3.0] Maximum turning rate in rad/s
   */
  constructor({ target, turnRate = 3.0 } = {}) {
    this.target = target;
    this.turnRate = turnRate;
  }

  /**
   * Steer entity velocity smoothly toward the target.
   * @param {import('./entity.js').Entity} entity The host entity
   * @param {number} dt Delta time in seconds
   */
  update(entity, dt) {
    const tgt = typeof this.target === 'function' ? this.target() : this.target;
    if (!tgt || !tgt.alive) return;

    // 1. Calculate vector to target
    const dx = tgt.pos.x - entity.pos.x;
    const dy = tgt.pos.y - entity.pos.y;
    const desiredAngle = Math.atan2(dy, dx);

    // 2. Current heading angle
    const currentAngle = Math.atan2(entity.vel.y, entity.vel.x);

    // 3. Find shortest angular distance [-PI, PI]
    let diff = desiredAngle - currentAngle;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;

    // 4. Steer current angle towards desired angle clamped by turnRate
    const step = Math.sign(diff) * Math.min(Math.abs(diff), this.turnRate * dt);
    const newAngle = currentAngle + step;

    // 5. Preserve current speed while altering direction
    const speed = entity.vel.length();
    entity.vel.x = Math.cos(newAngle) * speed;
    entity.vel.y = Math.sin(newAngle) * speed;
  }
}
