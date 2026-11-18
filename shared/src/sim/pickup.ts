import { Entity, Kind } from './entity.ts';
import { Vector2 } from './vector.ts';
import type { EntityId } from '../types.ts';
import type { Ship } from './ship.ts';

const TWO_PI = Math.PI * 2;

/**
 * Stationary / floating collectible pickup (Composition feature for M4).
 * Single-level inheritance from Entity.
 */
export type PickupType = 'SHIELD' | 'RAPID_FIRE';
export interface PickupOptions {
  pos: Vector2;
  type?: PickupType;
  id?: EntityId;
}

export class Pickup extends Entity {
  declare kind: typeof Kind.PICKUP;
  type: PickupType;
  pulseTime: number;

  /**
   */
  constructor({ pos, type = 'SHIELD', id }: PickupOptions) {
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
   */
  override update(dt: number): void {
    this.pulseTime += dt;
    this.angle += 1.5 * dt;
  }

  /**
   * Apply pickup effect to the player ship.
   */
  applyEffect(ship: Ship): void {
    if (this.type === 'SHIELD') ship.grantShield(5);
    else if (this.type === 'RAPID_FIRE') ship.grantRapidFire(8);
    this.alive = false;
  }

  /**
   * Render glowing vector pickup.
   */
  override render(ctx: CanvasRenderingContext2D): void {
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
