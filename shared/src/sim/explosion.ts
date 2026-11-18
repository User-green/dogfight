import { Entity, Kind } from './entity.ts';
import { Vector2 } from './vector.ts';
import type { Rng } from '../types.ts';

const TWO_PI = Math.PI * 2;

/**
 * Visual explosion effect consisting of expanding particle fragments.
 * Single-level inheritance from Entity.
 */
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  length: number;
}

export interface ExplosionOptions {
  pos: Vector2;
  particleCount?: number;
  ttl?: number;
  color?: string;
  rng: Rng;
}

export class Explosion extends Entity {
  declare kind: typeof Kind.EXPLOSION;
  ttl: number;
  initialTtl: number;
  color: string;
  particles: Particle[];

  /**
   */
  constructor({ pos, particleCount = 12, ttl = 0.6, color = '#ffffff', rng }: ExplosionOptions) {
    super({
      kind: Kind.EXPLOSION,
      pos: pos.clone(),
      vel: new Vector2(0, 0),
      radius: 0, // particles do not collide
      maxSpeed: Infinity,
    });

    this.ttl = ttl;
    this.initialTtl = ttl;
    this.color = color;

    // Generate radial burst particles
    this.particles = [];
    for (let i = 0; i < particleCount; i++) {
      const angle = (i / particleCount) * TWO_PI + (rng() - 0.5) * 0.4;
      const speed = 40 + rng() * 120;
      this.particles.push({
        x: 0,
        y: 0,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        length: 2 + rng() * 3,
      });
    }
  }

  /**
   * Advance particles outward and decrement lifetime.
   */
  override update(dt: number): void {
    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.alive = false;
      return;
    }

    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  /**
   * Render vector particle sparks.
   */
  override render(ctx: CanvasRenderingContext2D): void {
    const alpha = Math.max(0, this.ttl / this.initialTtl);

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.strokeStyle = this.color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.5;

    for (const p of this.particles) {
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - (p.vx * 0.04), p.y - (p.vy * 0.04));
      ctx.stroke();
    }

    ctx.restore();
  }
}
