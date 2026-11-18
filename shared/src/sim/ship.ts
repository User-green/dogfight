import { Entity, Kind } from './entity.ts';
import { Vector2 } from './vector.ts';
import { Bullet } from './bullet.ts';
import type { Arena, EntityId } from '../types.ts';

/** What the ship wants to do this tick. Server inputs use rotateLeft/rotateRight; the keyboard may use left/right. */
export interface ShipInput {
  readonly thrust?: boolean;
  readonly rotateLeft?: boolean;
  readonly rotateRight?: boolean;
  readonly left?: boolean;
  readonly right?: boolean;
  readonly fire?: boolean;
  /** seq of the network input this came from (lets the shooter match its predicted bullet) */
  readonly seq?: number;
}

/** The slice of World that Ship.fire needs: spawn + optional event emit. Keeps Ship independent of World. */
export interface Spawner {
  spawn(entity: Bullet): Bullet;
  emit?(type: string, detail?: object): void;
}

const ROTATION_SPEED = 4.2; // rad/s (~240 deg/s)
const THRUST_ACCEL = 400.0;  // units/s²
const MAX_SHIP_SPEED = 500.0;// units/s (cross arena in 2.0s)
const FIRE_COOLDOWN = 0.15;  // min seconds between shots (~6.6 shots/sec)
const BULLET_MUZZLE_SPEED = 650.0; // units/s

/**
 * Player Ship entity.
 * Single-level inheritance from Entity.
 */
export class Ship extends Entity {
  declare kind: typeof Kind.SHIP;
  /** Private hit points: external code cannot mutate them arbitrarily */
  #hp = 3;
  cooldownTimer: number;
  isThrusting: boolean;
  invulnTimer: number; // seconds of damage immunity (after a hit, respawn, or shield)
  rapidTimer: number; // seconds of rapid fire left
  respawnTimer: number; // > 0 while dead: counts down to respawn
  score: number;

  constructor({ pos = new Vector2(500, 500), angle = -Math.PI / 2, id }: { pos?: Vector2; angle?: number; id?: EntityId } = {}) {
    super({
      kind: Kind.SHIP,
      pos,
      vel: new Vector2(0, 0),
      angle,
      radius: 14, // circle collision boundary
      maxSpeed: MAX_SHIP_SPEED,
      id,
    });

    this.cooldownTimer = 0;
    this.isThrusting = false;
    this.invulnTimer = 0; // seconds of damage immunity (after a hit, respawn, or shield)
    this.rapidTimer = 0; // seconds of rapid fire left
    this.respawnTimer = 0; // > 0 while dead: counts down to respawn
    this.score = 0;
  }

  /**
   * Public getter for private #hp field.
   * Encapsulates health so external code cannot mutate it arbitrarily.
   */
  get hp(): number {
    return this.#hp;
  }

  /**
   * Deduct health from private #hp.
   */
  takeDamage(amount = 1): void {
    if (this.invulnTimer > 0) return;
    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp <= 0) {
      this.alive = false;
    } else {
      this.invulnTimer = 1.5; // short grace period so one asteroid cannot hit 60 times/s
    }
  }

  /** Mirror the server's hit points (a client-side copy of a server ship). */
  syncHp(hp: number): void {
    this.#hp = hp;
  }

  /** Pickup effect: temporary damage immunity. */
  grantShield(seconds = 5): void {
    this.invulnTimer = Math.max(this.invulnTimer, seconds);
  }

  /** Pickup effect: shorter fire cooldown. */
  grantRapidFire(seconds = 8): void {
    this.rapidTimer = Math.max(this.rapidTimer, seconds);
  }

  /**
   * Reset health and state on respawn.
   */
  respawn(safePos: Vector2): void {
    this.#hp = 3;
    this.alive = true;
    this.pos = safePos.clone();
    this.vel = new Vector2(0, 0);
    this.angle = -Math.PI / 2;
    this.cooldownTimer = 0.5;
    this.invulnTimer = 2.0; // spawn protection
  }

  /**
   * Update ship rotation, thrust, cooldown, and integration.
   */
  step(dt: number, input: ShipInput, arena?: Arena): void {
    if (!this.alive) return;

    // 1. Timers
    if (this.cooldownTimer > 0) this.cooldownTimer -= dt;
    if (this.invulnTimer > 0) this.invulnTimer -= dt;
    if (this.rapidTimer > 0) this.rapidTimer -= dt;

    // 2. Angular steering (A / D or Left / Right)
    let rotDir = 0;
    if (input.rotateLeft || input.left) rotDir -= 1;
    if (input.rotateRight || input.right) rotDir += 1;
    this.angle += rotDir * ROTATION_SPEED * dt;

    // 3. Thrust acceleration
    this.isThrusting = Boolean(input.thrust);
    if (this.isThrusting) {
      const heading = Vector2.fromAngle(this.angle);
      this.vel.x += heading.x * THRUST_ACCEL * dt;
      this.vel.y += heading.y * THRUST_ACCEL * dt;
    }

    // 4. Base entity physics (velocity integration, maxSpeed clamp, toroidal wrap)
    super.update(dt, arena);
  }

  /**
   * Fire a projectile from the ship's nose into the world.
   * Spawns bullet with inherited ship velocity + muzzle velocity.
   */
  fire(world: Spawner): Bullet | null {
    if (!this.alive || this.cooldownTimer > 0) return null;

    // 1. Heading vector of the ship
    const heading = Vector2.fromAngle(this.angle);

    // 2. Muzzle position (20 units along heading from center)
    const muzzlePos = this.pos.add(heading.scale(20));

    // 3. Galilean relativity: ship velocity + muzzle speed along heading
    const bulletVel = this.vel.add(heading.scale(BULLET_MUZZLE_SPEED));

    const bullet = new Bullet({
      pos: muzzlePos,
      vel: bulletVel,
      ttl: 1.2,
      shooterId: this.id,
    });

    world.spawn(bullet);
    world.emit?.('fired', { shooterId: this.id });
    this.cooldownTimer = this.rapidTimer > 0 ? FIRE_COOLDOWN / 3 : FIRE_COOLDOWN;
    return bullet;
  }

  /**
   * Render classic vector wireframe ship.
   */
  override render(ctx: CanvasRenderingContext2D): void {
    if (!this.alive) return;

    ctx.save();
    ctx.translate(this.pos.x, this.pos.y);
    ctx.rotate(this.angle);

    // Blink while invulnerable
    if (this.invulnTimer > 0 && Math.floor(this.invulnTimer * 10) % 2 === 0) {
      ctx.globalAlpha = 0.35;
    }
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.0;
    ctx.lineJoin = 'round';

    // Ship wireframe: pointing along local +X axis
    ctx.beginPath();
    ctx.moveTo(20, 0);      // Nose tip
    ctx.lineTo(-14, -11);   // Left wing tip
    ctx.lineTo(-8, 0);      // Inner notch
    ctx.lineTo(-14, 11);    // Right wing tip
    ctx.closePath();
    ctx.stroke();

    // Thruster flame when accelerating
    if (this.isThrusting) {
      ctx.beginPath();
      ctx.moveTo(-8, 0);
      ctx.lineTo(-18 - 8 * Math.abs(Math.sin(this.pos.x * 0.9 + this.pos.y * 1.3)), 0); // cosmetic flicker, deterministic
      ctx.strokeStyle = '#00ffff';
      ctx.stroke();
    }

    ctx.restore();
  }
}
