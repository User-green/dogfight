import { Entity, Kind } from './entity.js';
import { Vector2 } from './vector.js';

const TWO_PI = Math.PI * 2;

/**
 * Tiers of asteroids:
 * Tier 3 = Large (radius 36, slow, splits into 2 Mediums)
 * Tier 2 = Medium (radius 20, medium, splits into 2 Smalls)
 * Tier 1 = Small (radius 10, fast, disintegrates)
 */
const TIER_CONFIG = {
  3: { radius: 36, speedMin: 40,  speedMax: 80,  score: 20 },
  2: { radius: 20, speedMin: 70,  speedMax: 130, score: 50 },
  1: { radius: 10, speedMin: 110, speedMax: 200, score: 100 },
};

/**
 * Asteroid obstacle entity.
 * Single-level inheritance from Entity.
 */
export class Asteroid extends Entity {
  /**
   * @param {Object} options
   * @param {Vector2} options.pos Initial position
   * @param {Vector2} [options.vel] Initial velocity
   * @param {number} [options.tier=3] 3 (Large), 2 (Medium), 1 (Small)
   */
  constructor({ pos, vel, tier = 3 } = {}) {
    const config = TIER_CONFIG[tier] || TIER_CONFIG[3];
    const initialVel = vel || Vector2.fromAngle(
      Math.random() * TWO_PI,
      config.speedMin + Math.random() * (config.speedMax - config.speedMin)
    );

    super({
      kind: Kind.ASTEROID,
      pos,
      vel: initialVel,
      radius: config.radius,
      maxSpeed: Infinity,
    });

    this.tier = tier;
    this.scoreValue = config.score;
    this.angularVelocity = (Math.random() - 0.5) * 2.0; // rad/s tumble

    // Generate jagged vector wireframe vertices once at spawn
    this.vertices = this.#generatePolygonVertices(this.radius);
  }

  /**
   * Precomputes a classic 1979-style rocky wireframe outline.
   * @param {number} baseRadius
   * @returns {Array<{x: number, y: number}>}
   */
  #generatePolygonVertices(baseRadius) {
    const count = 10;
    const vertices = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * TWO_PI;
      // Perturb radius by ±25% for a craggy asteroid look
      const r = baseRadius * (0.75 + Math.random() * 0.5);
      vertices.push({
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
      });
    }
    return vertices;
  }

  /**
   * Advance tumble angle and integrate position.
   * @param {number} dt
   * @param {{ width: number, height: number }} arena
   */
  update(dt, arena) {
    this.angle += this.angularVelocity * dt;
    super.update(dt, arena);
  }

  /**
   * Split this asteroid into two smaller ones when destroyed.
   * @returns {Asteroid[]} Children asteroids (empty array if tier was 1)
   */
  split() {
    if (this.tier <= 1) return [];

    const nextTier = this.tier - 1;
    const currentSpeed = this.vel.length();
    const baseAngle = Math.atan2(this.vel.y, this.vel.x);

    // Two child fragments diverging at ±45 degrees with 1.3x speed boost
    const angle1 = baseAngle + 0.75;
    const angle2 = baseAngle - 0.75;
    const boostSpeed = Math.max(80, currentSpeed * 1.3);

    const child1 = new Asteroid({
      pos: this.pos.clone(),
      vel: Vector2.fromAngle(angle1, boostSpeed),
      tier: nextTier,
    });

    const child2 = new Asteroid({
      pos: this.pos.clone(),
      vel: Vector2.fromAngle(angle2, boostSpeed),
      tier: nextTier,
    });

    return [child1, child2];
  }

  /**
   * Draw classic vector wireframe rock.
   * @param {CanvasRenderingContext2D} ctx
   */
  render(ctx) {
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.angle);

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(this.vertices[0].x, this.vertices[0].y);
    for (let i = 1; i < this.vertices.length; i++) {
      ctx.lineTo(this.vertices[i].x, this.vertices[i].y);
    }
    ctx.closePath();
    ctx.stroke();

    ctx.restore();
  }
}
