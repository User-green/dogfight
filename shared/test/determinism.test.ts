import { test } from 'vitest';
import assert from 'node:assert/strict';
import { makeWorld, run } from './helpers.ts';
import { worldHash } from '../src/hash.ts';
import { mulberry32 } from '../src/rng.ts';

test('mulberry32: same seed gives the same sequence, different seeds differ', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const c = mulberry32(43);
  const xs = Array.from({ length: 5 }, a);
  assert.deepEqual(xs, Array.from({ length: 5 }, b));
  assert.notDeepEqual(xs, Array.from({ length: 5 }, c));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('same seed + same inputs => bit-identical world after 1000 ticks', () => {
  const r1 = makeWorld();
  const r2 = makeWorld();
  run(r1.world, r1.shipIds, 1000);
  run(r2.world, r2.shipIds, 1000);
  assert.equal(worldHash(r1.world), worldHash(r2.world));
});

test('the sim never touches Math.random or Date.now (poisoned for the whole run)', () => {
  const realRandom = Math.random;
  const realNow = Date.now;
  Math.random = () => {
    throw new Error('Math.random called inside the sim');
  };
  Date.now = () => {
    throw new Error('Date.now called inside the sim');
  };
  try {
    const { world, shipIds } = makeWorld();
    run(world, shipIds, 600);
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }
});

test('different seed => different world (the hash is actually sensitive)', () => {
  const a = makeWorld({ seed: 1 });
  const b = makeWorld({ seed: 2 });
  run(a.world, a.shipIds, 200);
  run(b.world, b.shipIds, 200);
  assert.notEqual(worldHash(a.world), worldHash(b.world));
});

test('the experiment: ONE Math.random() in the step makes two identical runs diverge', async () => {
  const { Ship } = await import('../src/sim/ship.ts');
  const original = Ship.prototype.step;
  Ship.prototype.step = function (dt, input, arena) {
    original.call(this, dt, input, arena);
    this.vel.x += (Math.random() - 0.5) * 20 * dt; // the sin: nondeterminism inside integrate
  };
  try {
    const a = makeWorld();
    const b = makeWorld();
    run(a.world, a.shipIds, 300);
    run(b.world, b.shipIds, 300);
    assert.notEqual(worldHash(a.world), worldHash(b.world));
  } finally {
    Ship.prototype.step = original;
  }
});
