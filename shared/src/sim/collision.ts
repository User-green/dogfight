import { Kind } from './entity.ts';
import { Explosion } from './explosion.ts';
import type { Entity } from './entity.ts';
import type { AnyEntity, World } from './world.ts';
import type { Ship } from './ship.ts';

/**
 * Circle-to-circle intersection test using squared distance (zero square roots).
 */
export function checkCircleCollision(a: Entity, b: Entity): boolean {
  const dx = a.pos.x - b.pos.x;
  const dy = a.pos.y - b.pos.y;
  const distSq = dx * dx + dy * dy;
  const radiusSum = a.radius + b.radius;
  return distSq < radiusSum * radiusSum;
}

/**
 * Broadphase collision detector generator.
 * Emits colliding [a, b] pairs so this system can be swapped
 * for a Spatial Hash Grid in Lab 7 without touching game logic.
 */
export function* findCollisions(world: World): Generator<[AnyEntity, AnyEntity]> {
  const entities = Array.from(world);
  const len = entities.length;

  for (let i = 0; i < len; i++) {
    const a = entities[i];
    if (!a?.alive || a.radius <= 0) continue;

    for (let j = i + 1; j < len; j++) {
      const b = entities[j];
      if (!b?.alive || b.radius <= 0) continue;

      // Filter non-colliding pair types early
      if (a.kind === Kind.BULLET && b.kind === Kind.BULLET) continue;
      if (a.kind === Kind.ASTEROID && b.kind === Kind.ASTEROID) continue;
      if (a.kind === Kind.EXPLOSION || b.kind === Kind.EXPLOSION) continue;

      // Don't collide bullet with the entity that fired it
      if (a.kind === Kind.BULLET && a.shooterId === b.id) continue;
      if (b.kind === Kind.BULLET && b.shooterId === a.id) continue;

      if (checkCircleCollision(a, b)) {
        yield [a, b];
      }
    }
  }
}

/**
 * Resolves gameplay consequences of collisions:
 * - Bullet hits Asteroid: bullet despawns, asteroid splits, explosion sparks, score awarded.
 * - Ship hits Asteroid: ship loses #hp, explosion sparks, respawns if destroyed.
 */
export function resolveCollisions(world: World, { onShipDestroyed }: { onShipDestroyed?: (ship: Ship) => void } = {}): void {
  for (const [a, b] of findCollisions(world)) {
    // Determine which is bullet, ship, asteroid, pickup
    const bullet = a.kind === Kind.BULLET ? a : b.kind === Kind.BULLET ? b : null;
    const asteroid = a.kind === Kind.ASTEROID ? a : b.kind === Kind.ASTEROID ? b : null;
    const ship = a.kind === Kind.SHIP ? a : b.kind === Kind.SHIP ? b : null;
    const pickup = a.kind === Kind.PICKUP ? a : b.kind === Kind.PICKUP ? b : null;

    // 1. Bullet vs Asteroid
    if (bullet && asteroid && bullet.alive && asteroid.alive) {
      bullet.alive = false;
      asteroid.alive = false;

      // Award points
      world.addScore(asteroid.scoreValue, bullet.shooterId);
      world.emit('hit', { kind: 'asteroid' });
      world.emit('exploded', { kind: 'asteroid', tier: asteroid.tier });

      // Spawn debris explosion
      world.spawn(new Explosion({ pos: asteroid.pos, particleCount: 14, color: '#ffffff', rng: world.rng }));

      // Split into smaller asteroids if tier > 1
      const fragments = asteroid.split(world.rng);
      for (const fragment of fragments) {
        world.spawn(fragment);
      }
      continue;
    }

    // 2. Ship vs Asteroid
    if (ship && asteroid && ship.alive && asteroid.alive) {
      const hpBefore = ship.hp;
      ship.takeDamage(1);
      if (ship.hp === hpBefore) continue; // grace period / shield: no damage, no effect
      world.emit('hit', { kind: 'ship' });

      // Spawn collision burst
      world.spawn(new Explosion({ pos: ship.pos, particleCount: 20, color: '#ff3333', rng: world.rng }));

      if (!ship.alive) world.emit('exploded', { kind: 'ship' });
      if (!ship.alive && onShipDestroyed) {
        onShipDestroyed(ship);
      }
      continue;
    }

    // 3. Ship vs Pickup
    if (ship && pickup && ship.alive && pickup.alive) {
      pickup.applyEffect(ship);
      world.spawn(new Explosion({ pos: pickup.pos, particleCount: 12, color: '#00ff88', rng: world.rng }));
      world.addScore(250, ship.id);
      world.emit('pickup', { type: pickup.type });
    }
  }
}
