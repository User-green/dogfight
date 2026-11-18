import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Match } from '../src/match.ts';
import { NetSim, validateNetsim } from '../src/netsim.ts';
import { TICK_MS } from 'shared/constants';
import { Kind } from 'shared/sim/entity';
import { asSeq, asTick } from 'shared/types';
import type { InputPacket, Snapshot } from 'shared/protocol';

type Inp = InputPacket['inputs'][number];
const inp = (seq: number, o: Partial<Omit<Inp, 'seq'>> = {}): Inp => ({ seq: asSeq(seq), thrust: false, turn: 0, fire: false, ...o });
const packet = (...inputs: Inp[]): InputPacket => ({ tick: asTick(0), inputs });
/** `.at(-1)` is `T | undefined` under noUncheckedIndexedAccess; a test wants a loud failure instead. */
function last(snaps: Snapshot[]): Snapshot {
  const s = snaps.at(-1);
  assert.ok(s, 'no snapshot yet');
  return s;
}

function setup(asteroids = 0) {
  const m = new Match({ asteroids, seed: 5 });
  const snaps: Snapshot[] = [];
  const p = m.addPlayer('p1', 'Pilot', (s) => snaps.push(s));
  return { m, p, snaps };
}

test('Match: one input per tick, lastProcessedSeq (ack) follows the input actually applied', () => {
  const { m, snaps } = setup();
  m.input('p1', packet(inp(1), inp(2), inp(3)));
  m.tickOnce();
  assert.equal(last(snaps).ack, 1);
  m.tickOnce();
  assert.equal(last(snaps).ack, 2);
  m.tickOnce();
  assert.equal(last(snaps).ack, 3);
  m.tickOnce(); // queue empty: ack stays, ship keeps its last input
  assert.equal(last(snaps).ack, 3);
  assert.equal(m.stats.starved, 1);
  assert.equal(last(snaps).tick, 4);
});

test('Match: redundant/duplicate inputs are ignored by seq, so packet loss costs nothing', () => {
  const { m, p } = setup();
  m.input('p1', packet(inp(1), inp(2), inp(3)));
  m.input('p1', packet(inp(2), inp(3), inp(4))); // overlapping redundancy
  assert.deepEqual(p.queue.map((i) => i.seq), [1, 2, 3, 4]);
  assert.equal(m.stats.inputsStale, 2);
});

test('Match: backlog is capped; the OLDEST inputs are dropped', () => {
  const { m, p } = setup();
  for (let s = 1; s <= 10; s++) m.input('p1', packet(inp(s)));
  assert.deepEqual(p.queue.map((i) => i.seq), [7, 8, 9, 10]);
  assert.equal(m.stats.inputsDropped, 6);
});

test('Match: the input moves THAT player\'s ship, per tick, with the shared dt (thrust accelerates)', () => {
  const { m, p } = setup();
  const before = p.ship.vel.length();
  m.input('p1', packet(inp(1, { thrust: true })));
  m.tickOnce();
  assert.ok(p.ship.vel.length() > before);
  assert.ok(Math.abs(p.ship.vel.length() - 400 / 30) < 1e-6, `expected 400/30 = 13.33, got ${p.ship.vel.length()}`);
});

test('Match: two players do not steer each other', () => {
  const m = new Match({ asteroids: 0, seed: 5 });
  const a = m.addPlayer('a', 'A', () => {});
  const b = m.addPlayer('b', 'B', () => {});
  m.input('a', packet(inp(1, { thrust: true })));
  m.tickOnce();
  assert.ok(a.ship.vel.length() > 0);
  assert.equal(b.ship.vel.length(), 0);
});

test('Match: fire tags the bullet with the input seq (the shooter matches its predicted bullet by it)', () => {
  const { m, p, snaps } = setup();
  m.world.step(0.6, { width: 1000, height: 1000 }, {}); // let spawn-protection cooldown (0.5 s) expire
  m.input('p1', packet(inp(7, { fire: true })));
  m.tickOnce();
  const bullets = last(snaps).ents.filter((e) => e.kind === Kind.BULLET);
  assert.equal(bullets.length, 1);
  const bullet = bullets[0];
  assert.ok(bullet && bullet.kind === Kind.BULLET);
  assert.equal(bullet.fseq, 7);
  assert.equal(bullet.shooter, p.ship.id);
});

test('Match: starved player never auto-fires', () => {
  const { m, snaps } = setup();
  m.world.step(0.6, { width: 1000, height: 1000 }, {});
  m.input('p1', packet(inp(1, { fire: true })));
  for (let i = 0; i < 6; i++) m.tickOnce();
  assert.equal(last(snaps).ents.filter((e) => e.kind === Kind.BULLET).length, 1);
});

test('Match: removePlayer removes the ship; the snapshot stops listing it', () => {
  const { m, snaps } = setup();
  m.addPlayer('p2', 'Other', () => {});
  m.removePlayer('p2');
  m.tickOnce();
  assert.equal(last(snaps).ents.filter((e) => e.kind === Kind.SHIP).length, 1);
});

test('Match: a cleared wave spawns a bigger one', () => {
  const { m, snaps } = setup(2);
  for (const a of [...m.world.ofKind(Kind.ASTEROID)]) m.world.despawn(a.id);
  m.tickOnce(); // sweeps them
  m.tickOnce(); // sees zero asteroids
  assert.equal(last(snaps).ents.filter((e) => e.kind === Kind.ASTEROID).length, 4);
});

test('Match timer: 30 Hz with absolute targets (mean interval within 1 ms of 33.33, no drift)', async () => {
  const m = new Match({ asteroids: 1, seed: 1 });
  m.start();
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, 1500));
  m.stop();
  const elapsed = performance.now() - t0;
  const expected = elapsed / TICK_MS;
  assert.ok(Math.abs(m.stats.ticks - expected) <= 1.5, `ticks=${m.stats.ticks} expected~${expected.toFixed(1)}`);
  assert.ok(m.stats.jitterMs < 3, `mean jitter ${m.stats.jitterMs} ms`);
  assert.equal(m.stats.overruns, 0);
});

test('Match timer: lateness does not accumulate (next delay shrinks), a long stall resyncs instead of spiralling', () => {
  let clock = 0;
  let pending: { fn: () => void; ms: number } | null = null;
  const cur = () => {
    assert.ok(pending, 'no timer scheduled');
    return pending;
  };
  const m = new Match({ asteroids: 0, seed: 1, now: () => clock, setTimer: (fn, ms) => {
      pending = { fn, ms };
      return pending as unknown as ReturnType<typeof setTimeout>; // the Match never inspects the handle
    }, clearTimer: () => {} });
  m.start();
  assert.ok(Math.abs(cur().ms - TICK_MS) < 1e-9, 'first tick is one interval away');

  clock = TICK_MS + 10; // the timer fired 10 ms late
  cur().fn();
  assert.ok(Math.abs(cur().ms - (2 * TICK_MS - clock)) < 1e-9, `next delay ${cur().ms} should be 2*33.33 - now = ${(2 * TICK_MS - clock).toFixed(2)}`);
  assert.ok(cur().ms < TICK_MS, 'shorter than a full interval: it catches up');

  clock = 5000; // the process was frozen for ~5 s
  cur().fn();
  assert.equal(m.stats.resyncs, 1);
  assert.ok(Math.abs(cur().ms - TICK_MS) < 1e-9, 'after a resync we are one interval from now, not 150 ticks behind');
  assert.equal(m.stats.ticks, 2, 'it ran 1 tick for the stall, not 150 catch-up ticks');
});

test('NetSim: disabled = synchronous passthrough', () => {
  const sim = new NetSim({});
  let called = 0;
  sim.deliver('in', () => called++);
  assert.equal(called, 1);
});

test('NetSim: drop 100% drops everything, drop 0 drops nothing; counts agree', async () => {
  const all = new NetSim({ drop: 100 });
  let n = 0;
  for (let i = 0; i < 50; i++) all.deliver('out', () => n++);
  assert.equal(n, 0);
  assert.equal(all.stats.dropped, 50);

  const none = new NetSim({ lag: 2 });
  for (let i = 0; i < 20; i++) none.deliver('out', () => n++);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(n, 20);
});

test('NetSim: delay is lag/2 +- jitter/2 per direction, and order is preserved', async () => {
  const sim = new NetSim({ lag: 100, jitter: 60 });
  const seen: [number, number][] = [];
  const t0 = performance.now();
  for (let i = 0; i < 40; i++) sim.deliver('out', () => seen.push([i, performance.now() - t0]));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(seen.length, 40);
  assert.deepEqual(seen.map((s) => s[0]), [...Array(40).keys()], 'order preserved');
  for (const [, ms] of seen) assert.ok(ms >= 50 - 30 - 3 && ms <= 50 + 30 + 40, `delay ${ms}`); // jitter 60 => +-30 ms around lag/2 = 50
});

test('NetSim: close() cancels packets still in flight', async () => {
  const sim = new NetSim({ lag: 200 });
  let n = 0;
  sim.deliver('in', () => n++);
  sim.close();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(n, 0);
});

test('validateNetsim: rejects out-of-range and non-numbers', () => {
  assert.deepEqual(validateNetsim({ lag: 100, jitter: 30, drop: 2 }), { lag: 100, jitter: 30, drop: 2 });
  for (const bad of [{ lag: -1 }, { lag: 1e9 }, { drop: 101 }, { jitter: 'x' }, { lag: NaN }, null]) assert.equal(validateNetsim(bad), null);
});
