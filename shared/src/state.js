// Entity <-> plain-data state. A snapshot is the list of these plain objects; both codecs encode exactly this shape.
// Only the kinds that matter over the network are replicated (explosions are cosmetic and never sent).
import { Kind } from './sim/entity.js';
import { Ship } from './sim/ship.js';
import { Bullet } from './sim/bullet.js';
import { Asteroid } from './sim/asteroid.js';
import { Pickup } from './sim/pickup.js';
import { Vector2 } from './sim/vector.js';
import { mulberry32 } from './rng.js';

export const PICKUP_TYPES = ['SHIELD', 'RAPID_FIRE'];

/** Angles in this sim grow without bound; the wire format keeps them in (-PI, PI]. */
export const normAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Shortest signed distance from `from` to `to` on a wrapping axis of length `size`. */
export function wrapDelta(from, to, size) {
  let d = to - from;
  if (d > size / 2) d -= size;
  else if (d < -size / 2) d += size;
  return d;
}

/** @returns {object|null} plain state, or null for kinds that are not replicated */
export function entityState(e) {
  const base = { id: e.id, kind: e.kind, x: e.pos.x, y: e.pos.y };
  switch (e.kind) {
    case Kind.SHIP:
      return { ...base, vx: e.vel.x, vy: e.vel.y, a: normAngle(e.angle), hp: e.hp, alive: e.alive, thrust: e.isThrusting,
        cd: Math.max(0, e.cooldownTimer), inv: Math.max(0, e.invulnTimer), rap: Math.max(0, e.rapidTimer), score: e.score };
    case Kind.BULLET:
      return { ...base, vx: e.vel.x, vy: e.vel.y, ttl: Math.max(0, e.ttl), shooter: e.shooterId ?? 0, fseq: e.fireSeq };
    case Kind.ASTEROID:
      return { ...base, vx: e.vel.x, vy: e.vel.y, a: normAngle(e.angle), tier: e.tier };
    case Kind.PICKUP:
      return { ...base, ptype: PICKUP_TYPES.indexOf(e.type) };
    default:
      return null;
  }
}

export function snapshotEntities(world) {
  const ents = [];
  for (const e of world) {
    if (!e.alive && e.kind !== Kind.SHIP) continue;
    const s = entityState(e);
    if (s) ents.push(s);
  }
  return ents;
}

/** Build a local copy of a server entity. Cosmetic randomness (asteroid outline) is seeded by the id: every client draws the same rock. */
export function createFromState(s) {
  const pos = new Vector2(s.x, s.y);
  let e;
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
      throw new Error(`cannot create kind ${s.kind}`);
  }
  applyState(e, s);
  return e;
}

/** Overwrite an entity's replicated fields from state (used for proxies and for reconciliation). */
export function applyState(e, s) {
  e.pos.x = s.x;
  e.pos.y = s.y;
  if (s.vx !== undefined) {
    e.vel.x = s.vx;
    e.vel.y = s.vy;
  }
  if (s.a !== undefined) e.angle = s.a;
  switch (e.kind) {
    case Kind.SHIP:
      e.syncHp(s.hp);
      e.alive = s.alive;
      e.isThrusting = s.thrust;
      e.cooldownTimer = s.cd;
      e.invulnTimer = s.inv;
      e.rapidTimer = s.rap;
      e.score = s.score;
      break;
    case Kind.BULLET:
      e.ttl = s.ttl;
      e.shooterId = s.shooter;
      e.fireSeq = s.fseq;
      break;
    case Kind.ASTEROID:
      e.tier = s.tier;
      break;
  }
}
