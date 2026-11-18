import { Entity, Kind } from './entity.js';
import { Vector2 } from './vector.js';

const TWO_PI = Math.PI * 2;

/**
 * Stationary / floating collectible pickup (Composition feature for M4).
 * Single-level inheritance from Entity.
 */
export class Pickup extends Entity {
  /**
   * @param {Object} options
   * @param {Vector2} options.pos
   * @param {'SHIELD'|'RAPID_FIRE'} [options.type='SHIELD']
   */
  constructor({ pos, type = 'SHIELD', id } = {}) {
    super({
      kind: Kind.PICKUP,
      pos,
      vel: new Vector2(0, 0),
      radius: 12,
      maxSpeed: 0,
      id,
    });

    this.type = type;
    this.pulseTime = 0;
  }

  /**
   * Gently pulse and rotate.
   * @param {number} dt
   */
  update(dt) {
    this.pulseTime += dt;
    this.angle += 1.5 * dt;
  }

  /**
   * Apply pickup effect to the player ship.
   * @param {import('./ship.js').Ship} ship
   */
  applyEffect(ship) {
    if (this.type === 'SHIELD') ship.grantShield(5);
    else if (this.type === 'RAPID_FIRE') ship.grantRapidFire(8);
    this.alive = false;
  }

  /**
   * Render glowing vector pickup.
   * @param {CanvasRenderingContext2D} ctx
   */
  render(ctx) {
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.angle);

    const pulse = 1 + Math.sin(this.pulseTime * 5) * 0.15;
    ctx.scale(pulse, pulse);

    if (this.type === 'SHIELD') {
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 1.8;
      // Draw a cross
      ctx.beginPath();
      ctx.moveTo(-8, 0); ctx.lineTo(8, 0);
      ctx.moveTo(0, -8); ctx.lineTo(0, 8);
      ctx.stroke();

      // Enclosing diamond
      ctx.beginPath();
      ctx.moveTo(0, -12); ctx.lineTo(12, 0); ctx.lineTo(0, 12); ctx.lineTo(-12, 0);
      ctx.closePath();
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#ffff00';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, TWO_PI);
      ctx.stroke();
    }

    ctx.restore();
  }
}
