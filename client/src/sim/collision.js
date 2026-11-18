import { Kind } from './entity.js';
import { Explosion } from './explosion.js';

/**
 * Circle-to-circle intersection test using squared distance (zero square roots).
 * @param {import('./entity.js').Entity} a
 * @param {import('./entity.js').Entity} b
 * @returns {boolean}
 */
export function checkCircleCollision(a, b) {
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
 * @param {import('./world.js').World} world
 * @returns {Generator<[import('./entity.js').Entity, import('./entity.js').Entity]>}
 */
export function* findCollisions(world) {
  const entities = Array.from(world);
  const len = entities.length;

  for (let i = 0; i < len; i++) {
    const a = entities[i];
    if (!a.alive || a.radius <= 0) continue;

    for (let j = i + 1; j < len; j++) {
      const b = entities[j];
      if (!b.alive || b.radius <= 0) continue;

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
 * @param {import('./world.js').World} world
 * @param {Object} [options]
 * @param {Function} [options.onShipDestroyed]
 */
export function resolveCollisions(world, { onShipDestroyed } = {}) {
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
      world.addScore(asteroid.scoreValue || 50);
      world.emit('hit', { kind: 'asteroid' });
      world.emit('exploded', { kind: 'asteroid', tier: asteroid.tier });

      // Spawn debris explosion
      world.spawn(new Explosion({ pos: asteroid.pos, particleCount: 14, color: '#ffffff' }));

      // Split into smaller asteroids if tier > 1
      const fragments = asteroid.split();
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
      world.spawn(new Explosion({ pos: ship.pos, particleCount: 20, color: '#ff3333' }));

      if (!ship.alive) world.emit('exploded', { kind: 'ship' });
      if (!ship.alive && onShipDestroyed) {
        onShipDestroyed(ship);
      }
      continue;
    }

    // 3. Ship vs Pickup
    if (ship && pickup && ship.alive && pickup.alive) {
      pickup.applyEffect(ship);
      world.spawn(new Explosion({ pos: pickup.pos, particleCount: 12, color: '#00ff88' }));
      world.addScore(250);
      world.emit('pickup', { type: pickup.type });
      continue;
    }
  }
}
