import { Entity, Kind } from './entity.js';
import { Vector2 } from './vector.js';

const TWO_PI = Math.PI * 2;

/**
 * Visual explosion effect consisting of expanding particle fragments.
 * Single-level inheritance from Entity.
 */
export class Explosion extends Entity {
  /**
   * @param {Object} options
   * @param {Vector2} options.pos Explosion origin
   * @param {number} [options.particleCount=12]
   * @param {number} [options.ttl=0.6] Lifetime in seconds
   * @param {string} [options.color='#ffffff']
   */
  constructor({ pos, particleCount = 12, ttl = 0.6, color = '#ffffff', rng } = {}) {
    if (typeof rng !== 'function') throw new TypeError('Explosion needs a seeded rng');
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
   * @param {number} dt
   */
  update(dt) {
    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.alive = false;
      return;
    }

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  /**
   * Render vector particle sparks.
   * @param {CanvasRenderingContext2D} ctx
   */
  render(ctx) {
    const alpha = Math.max(0, this.ttl / this.initialTtl);

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.strokeStyle = this.color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.5;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - (p.vx * 0.04), p.y - (p.vy * 0.04));
      ctx.stroke();
    }

    ctx.restore();
  }
}
