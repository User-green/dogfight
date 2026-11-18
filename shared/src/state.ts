// Entity <-> plain-data state. A snapshot is the list of these plain objects; both codecs encode exactly this shape.
// Only the kinds that matter over the network are replicated (explosions are cosmetic and never sent).
import { Kind } from './sim/entity.ts';
import { Ship } from './sim/ship.ts';
import { Bullet } from './sim/bullet.ts';
import { Asteroid } from './sim/asteroid.ts';
import { Pickup } from './sim/pickup.ts';
import { Vector2 } from './sim/vector.ts';
import { mulberry32 } from './rng.ts';
import { NO_ID, assertNever, asSeq } from './types.ts';
import type { AnyEntity } from './sim/world.ts';
import type { World } from './sim/world.ts';
import type { AsteroidState, BulletState, EntityState, PickupState, ShipState } from './protocol.ts';
import type { PickupType } from './sim/pickup.ts';

export const PICKUP_TYPES = ['SHIELD', 'RAPID_FIRE'] as const satisfies readonly PickupType[];

/** Angles in this sim grow without bound; the wire format keeps them in (-PI, PI]. */
export const normAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Shortest signed distance from `from` to `to` on a wrapping axis of length `size`. */
export function wrapDelta(from: number, to: number, size: number): number {
  let d = to - from;
  if (d > size / 2) d -= size;
  else if (d < -size / 2) d += size;
  return d;
}

/** Plain state of an entity, or null for kinds that are not replicated (explosions are cosmetic). */
export function entityState(e: AnyEntity): EntityState | null {
  const base = { id: e.id, x: e.pos.x, y: e.pos.y };
  switch (e.kind) {
    case Kind.SHIP:
      return { ...base, kind: e.kind, vx: e.vel.x, vy: e.vel.y, a: normAngle(e.angle), hp: e.hp, alive: e.alive, thrust: e.isThrusting,
        cd: Math.max(0, e.cooldownTimer), inv: Math.max(0, e.invulnTimer), rap: Math.max(0, e.rapidTimer), score: e.score };
    case Kind.BULLET:
      return { ...base, kind: e.kind, vx: e.vel.x, vy: e.vel.y, ttl: Math.max(0, e.ttl), shooter: e.shooterId ?? NO_ID, fseq: asSeq(e.fireSeq) };
    case Kind.ASTEROID:
      return { ...base, kind: e.kind, vx: e.vel.x, vy: e.vel.y, a: normAngle(e.angle), tier: e.tier };
    case Kind.PICKUP:
      return { ...base, kind: e.kind, ptype: e.type === 'SHIELD' ? 0 : 1 };
    case Kind.EXPLOSION:
      return null;
    default:
      return assertNever(e);
  }
}

export function snapshotEntities(world: World): EntityState[] {
  const ents: EntityState[] = [];
  for (const e of world) {
    if (!e.alive && e.kind !== Kind.SHIP) continue;
    const s = entityState(e);
    if (s) ents.push(s);
  }
  return ents;
}

/** Entities that exist on both sides of the wire (explosions are client-only decoration). */
export type ReplicatedEntity = Ship | Bullet | Asteroid | Pickup;

/** Build a local copy of a server entity. Cosmetic randomness (asteroid outline) is seeded by the id: every client draws the same rock. */
export function createFromState(s: EntityState): ReplicatedEntity {
  const pos = new Vector2(s.x, s.y);
  let e: ReplicatedEntity;
  switch (s.kind) {
    case Kind.SHIP:
      e = new Ship({ pos, id: s.id });
      break;
    case Kind.BULLET:
      e = new Bullet({ pos, vel: new Vector2(s.vx, s.vy), ttl: s.ttl, shooterId: s.shooter, id: s.id });
      break;
    case Kind.ASTEROID:
      e = new Asteroid({ pos, vel: new Vector2(s.vx, s.vy), tier: s.tier, rng: mulberry32(s.id), id: s.id });
      break;
    case Kind.PICKUP:
      e = new Pickup({ pos, type: PICKUP_TYPES[s.ptype] ?? 'SHIELD', id: s.id });
      e.pulseTime = 0;
      break;
    default:
      return assertNever(s);
  }
  applyState(e, s);
  return e;
}

function applyShip(e: Ship, s: ShipState): void {
  e.vel.x = s.vx;
  e.vel.y = s.vy;
  e.angle = s.a;
  e.syncHp(s.hp);
  e.alive = s.alive;
  e.isThrusting = s.thrust;
  e.cooldownTimer = s.cd;
  e.invulnTimer = s.inv;
  e.rapidTimer = s.rap;
  e.score = s.score;
}

function applyBullet(e: Bullet, s: BulletState): void {
  e.vel.x = s.vx;
  e.vel.y = s.vy;
  e.ttl = s.ttl;
  e.shooterId = s.shooter;
  e.fireSeq = s.fseq;
}

function applyAsteroid(e: Asteroid, s: AsteroidState): void {
  e.vel.x = s.vx;
  e.vel.y = s.vy;
  e.angle = s.a;
  e.tier = s.tier;
}

/** Overwrite an entity's replicated fields from state (used for proxies and for reconciliation). A kind mismatch is ignored: it can only be a stale proxy. */
export function applyState(e: AnyEntity, s: EntityState): void {
  e.pos.x = s.x;
  e.pos.y = s.y;
  if (e.kind === Kind.SHIP && s.kind === Kind.SHIP) applyShip(e, s);
  else if (e.kind === Kind.BULLET && s.kind === Kind.BULLET) applyBullet(e, s);
  else if (e.kind === Kind.ASTEROID && s.kind === Kind.ASTEROID) applyAsteroid(e, s);
}

export type { PickupState };
