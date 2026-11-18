import { Entity, Kind } from './entity.ts';
import { Vector2 } from './vector.ts';
import type { Arena, EntityId, Rng } from '../types.ts';

const TWO_PI = Math.PI * 2;

/**
 * Tiers of asteroids:
 * Tier 3 = Large (radius 36, slow, splits into 2 Mediums)
 * Tier 2 = Medium (radius 20, medium, splits into 2 Smalls)
 * Tier 1 = Small (radius 10, fast, disintegrates)
 */
export type Tier = 1 | 2 | 3;

interface TierConfig {
  radius: number;
  speedMin: number;
  speedMax: number;
  score: number;
}

const TIER_CONFIG: Record<Tier, TierConfig> = {
  3: { radius: 36, speedMin: 40,  speedMax: 80,  score: 20 },
  2: { radius: 20, speedMin: 70,  speedMax: 130, score: 50 },
  1: { radius: 10, speedMin: 110, speedMax: 200, score: 100 },
};

/**
 * Asteroid obstacle entity.
 * Single-level inheritance from Entity.
 */
export interface AsteroidOptions {
  pos: Vector2;
  vel?: Vector2;
  tier?: Tier;
  rng: Rng;
  id?: EntityId;
}

export class Asteroid extends Entity {
  declare kind: typeof Kind.ASTEROID;
  tier: Tier;
  scoreValue: number;
  angularVelocity: number;
  vertices: ReadonlyArray<{ readonly x: number; readonly y: number }>;

  /**
   */
  constructor({ pos, vel, tier = 3, rng, id }: AsteroidOptions) {
    const config = TIER_CONFIG[tier];
    const initialVel = vel || Vector2.fromAngle(
      rng() * TWO_PI,
      config.speedMin + rng() * (config.speedMax - config.speedMin)
    );

    super({
      kind: Kind.ASTEROID,
      pos,
      vel: initialVel,
      radius: config.radius,
      maxSpeed: Infinity,
      id,
    });

    this.tier = tier;
    this.scoreValue = config.score;
    this.angularVelocity = (rng() - 0.5) * 2.0; // rad/s tumble

    // Generate jagged vector wireframe vertices once at spawn
    this.vertices = this.#generatePolygonVertices(this.radius, rng);
  }

  /**
   * Precomputes a classic 1979-style rocky wireframe outline.
   */
  #generatePolygonVertices(baseRadius: number, rng: Rng): Array<{ x: number; y: number }> {
    const count = 10;
    const vertices: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * TWO_PI;
      // Perturb radius by ±25% for a craggy asteroid look
      const r = baseRadius * (0.75 + rng() * 0.5);
      vertices.push({
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
      });
    }
    return vertices;
  }

  /**
   * Advance tumble angle and integrate position.
   */
  override update(dt: number, arena?: Arena): void {
    this.angle += this.angularVelocity * dt;
    super.update(dt, arena);
  }

  /**
   * Split this asteroid into two smaller ones when destroyed.
   */
  split(rng: Rng): Asteroid[] {
    if (this.tier === 1) return [];

    const nextTier: Tier = this.tier === 3 ? 2 : 1;
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
      rng,
    });

    const child2 = new Asteroid({
      pos: this.pos.clone(),
      vel: Vector2.fromAngle(angle2, boostSpeed),
      tier: nextTier,
      rng,
    });

    return [child1, child2];
  }

  /**
   * Draw classic vector wireframe rock.
   */
  override render(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.angle);

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';

    ctx.beginPath();
    this.vertices.forEach((v, i) => (i === 0 ? ctx.moveTo(v.x, v.y) : ctx.lineTo(v.x, v.y)));
    ctx.closePath();
    ctx.stroke();

    ctx.restore();
  }
}
