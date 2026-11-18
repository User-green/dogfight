import { describe, expect, test } from 'vitest';
import { Vector2 } from '../src/sim/vector.ts';
import { HomingBehavior } from '../src/sim/homing.ts';
import { Bullet } from '../src/sim/bullet.ts';
import { Ship } from '../src/sim/ship.ts';
import { Asteroid } from '../src/sim/asteroid.ts';
import { Pickup } from '../src/sim/pickup.ts';
import { Explosion } from '../src/sim/explosion.ts';
import { World } from '../src/sim/world.ts';
import { ARENA } from '../src/constants.ts';
import { applyState, createFromState, entityState, normAngle, snapshotEntities, wrapDelta } from '../src/state.ts';
import { Kind } from '../src/sim/entity.ts';
import { codecs } from '../src/codec/index.ts';
import { mulberry32 } from '../src/rng.ts';
import { makeWorld, run } from './helpers.ts';

/** A canvas stand-in that records every call: enough to prove render() draws and balances save/restore. */
function recorder() {
  const calls: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, prop: string) => (prop in target ? target[prop] : (..._a: unknown[]) => void calls.push(prop)),
    set: (target, prop: string, value) => ((target[prop] = value), true),
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}
const balanced = (calls: string[]) => calls.filter((c) => c === 'save').length === calls.filter((c) => c === 'restore').length;

describe('Vector2', () => {
  test('pure ops do not mutate; in-place ops do', () => {
    const a = new Vector2(3, 4);
    expect(a.length()).toBe(5);
    expect(a.lengthSq()).toBe(25);
    expect(a.scale(2)).toMatchObject({ x: 6, y: 8 });
    expect(a.dot(new Vector2(1, 0))).toBe(3);
    expect(a.normalize().length()).toBeCloseTo(1);
    expect(new Vector2(0, 0).normalize()).toMatchObject({ x: 0, y: 0 });
    expect(new Vector2(1, 0).rotate(Math.PI / 2).y).toBeCloseTo(1);
    expect(a.clone()).not.toBe(a);
    expect(a).toMatchObject({ x: 3, y: 4 });
    expect(a.addInPlace(new Vector2(1, 1)).scaleInPlace(2)).toMatchObject({ x: 8, y: 10 });
    expect(Vector2.fromAngle(0, 5)).toMatchObject({ x: 5, y: 0 });
  });
});

describe('state helpers', () => {
  test('normAngle maps into (-PI, PI]; wrapDelta takes the short way round', () => {
    expect(normAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(normAngle(-0.5)).toBeCloseTo(-0.5);
    expect(wrapDelta(10, 990, 1000)).toBe(-20);
    expect(wrapDelta(990, 10, 1000)).toBe(20);
    expect(wrapDelta(10, 20, 1000)).toBe(10);
  });

  test('entityState -> createFromState -> entityState is stable for every replicated kind; explosions are not replicated', () => {
    const { world, shipIds } = makeWorld({ ships: 2, asteroids: 3 });
    run(world, shipIds, 60);
    const ents = snapshotEntities(world);
    expect(new Set(ents.map((e) => e.kind))).toEqual(new Set([Kind.SHIP, Kind.ASTEROID, Kind.PICKUP, Kind.BULLET]));
    for (const s of ents) expect(entityState(createFromState(s))).toEqual(s);
    expect(entityState(new Explosion({ pos: new Vector2(1, 1), rng: mulberry32(1) }))).toBeNull();
  });

  test('applyState ignores a kind mismatch (stale proxy)', () => {
    const rock = new Asteroid({ pos: new Vector2(5, 5), tier: 2, rng: mulberry32(1) });
    const shipState = entityState(new Ship({ pos: new Vector2(9, 9) }));
    if (!shipState) throw new Error('ship must replicate');
    const before = rock.vel.x;
    applyState(rock, shipState);
    expect(rock.pos.x).toBe(9); // position always applies
    expect(rock.vel.x).toBe(before); // kind-specific fields do not
  });

  test('unknown pickup type byte falls back to SHIELD', () => {
    const p = createFromState({ kind: Kind.PICKUP, id: 5 as never, x: 1, y: 1, ptype: 1 });
    expect(p).toBeInstanceOf(Pickup);
    expect((p as Pickup).type).toBe('RAPID_FIRE');
  });
});

describe('HomingBehavior', () => {
  test('steers toward a target by at most turnRate*dt, preserving speed', () => {
    const b = new Bullet({ pos: new Vector2(0, 0), vel: new Vector2(10, 0) });
    const target = new Ship({ pos: new Vector2(0, 100) });
    new HomingBehavior({ target, turnRate: 1 }).update(b, 0.1);
    expect(Math.atan2(b.vel.y, b.vel.x)).toBeCloseTo(0.1);
    expect(b.vel.length()).toBeCloseTo(10);
  });

  test('accepts a target getter; dead, missing or null targets leave velocity alone', () => {
    const b = new Bullet({ pos: new Vector2(0, 0), vel: new Vector2(10, 0) });
    const dead = new Ship({ pos: new Vector2(0, 100) });
    dead.alive = false;
    new HomingBehavior({ target: () => dead }).update(b, 1);
    new HomingBehavior({ target: () => null }).update(b, 1);
    expect(b.vel).toMatchObject({ x: 10, y: 0 });
    const live = new Ship({ pos: new Vector2(-100, -1) }); // behind: diff wraps through +-PI
    new HomingBehavior({ target: () => live, turnRate: 100 }).update(b, 1);
    expect(b.vel.x).toBeLessThan(0);
  });
});

describe('entities: update and render', () => {
  test('pickup pulses, applies effects exactly once, draws both variants', () => {
    const ship = new Ship({ pos: new Vector2(0, 0) });
    const shield = new Pickup({ pos: new Vector2(1, 1), type: 'SHIELD' });
    shield.update(0.5);
    expect(shield.pulseTime).toBeCloseTo(0.5);
    shield.applyEffect(ship);
    expect(ship.invulnTimer).toBeGreaterThan(0);
    expect(shield.alive).toBe(false);
    new Pickup({ pos: new Vector2(1, 1), type: 'RAPID_FIRE' }).applyEffect(ship);
    expect(ship.rapidTimer).toBeGreaterThan(0);
    for (const type of ['SHIELD', 'RAPID_FIRE'] as const) {
      const { ctx, calls } = recorder();
      new Pickup({ pos: new Vector2(1, 1), type }).render(ctx);
      expect(calls).toContain('stroke');
      expect(balanced(calls)).toBe(true);
    }
  });

  test('explosion ages out; every entity kind renders with balanced save/restore', () => {
    const boom = new Explosion({ pos: new Vector2(10, 10), ttl: 0.2, rng: mulberry32(3) });
    boom.update(0.1);
    expect(boom.alive).toBe(true);
    boom.update(0.2);
    expect(boom.alive).toBe(false);

    const ship = new Ship({ pos: new Vector2(10, 10) });
    ship.isThrusting = true;
    ship.invulnTimer = 0.05;
    const dead = new Ship({ pos: new Vector2(1, 1) });
    dead.alive = false;
    const drawables = [
      new Explosion({ pos: new Vector2(1, 1), rng: mulberry32(3) }),
      new Bullet({ pos: new Vector2(1, 1), vel: new Vector2(1, 0) }),
      new Asteroid({ pos: new Vector2(1, 1), tier: 3, rng: mulberry32(2) }),
      ship,
    ];
    for (const e of drawables) {
      const { ctx, calls } = recorder();
      e.render(ctx);
      expect(calls.length, e.constructor.name).toBeGreaterThan(2);
      expect(balanced(calls)).toBe(true);
    }
    const { ctx, calls } = recorder();
    dead.render(ctx);
    expect(calls).toEqual([]); // a dead ship draws nothing
  });

  test('bullet expires by ttl; asteroid splits into two smaller ones', () => {
    const b = new Bullet({ pos: new Vector2(0, 0), vel: new Vector2(1, 0), ttl: 0.1 });
    b.update(0.2);
    expect(b.alive).toBe(false);
    const rock = new Asteroid({ pos: new Vector2(5, 5), tier: 3, rng: mulberry32(4) });
    const kids = rock.split(mulberry32(5));
    expect(kids).toHaveLength(2);
    expect(kids.every((k) => k.tier === 2)).toBe(true);
  });
});

describe('World', () => {
  test('spawn assigns increasing ids; despawn defers, remove is immediate; render skips dead', () => {
    const w = new World({ seed: 1 });
    const a = w.spawn(new Bullet({ pos: new Vector2(0, 0), vel: new Vector2(0, 0) }));
    const b = w.spawn(new Bullet({ pos: new Vector2(0, 0), vel: new Vector2(0, 0) }));
    expect(b.id).toBeGreaterThan(a.id);
    w.despawn(a.id);
    expect(w.get(a.id)).toBe(a); // still present until the sweep
    expect(a.alive).toBe(false);
    const drawn: number[] = [];
    w.render(recorder().ctx, (_c, e) => drawn.push(e.id));
    expect(drawn).toEqual([b.id]);
    w.render(recorder().ctx);
    w.remove(b.id);
    expect(w.get(b.id)).toBeUndefined();
    w.despawn(b.id); // unknown id: no-op
  });

  test('randomSafeSpot avoids entities and falls back to the centre when crowded', () => {
    const w = new World({ seed: 2 });
    for (let x = 0; x <= ARENA.width; x += 20)
      for (let y = 0; y <= ARENA.height; y += 20) w.spawn(new Asteroid({ pos: new Vector2(x, y), tier: 3, rng: mulberry32(1) }));
    expect(w.randomSafeSpot(ARENA, 50)).toMatchObject({ x: ARENA.width / 2, y: ARENA.height / 2 });
  });
});

describe('codec registry', () => {
  test('both codecs are registered under their names', () => {
    expect(Object.keys(codecs).sort()).toEqual(['binary', 'json']);
    for (const [name, c] of Object.entries(codecs)) expect(c.name).toBe(name);
  });
});
