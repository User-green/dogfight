import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createLoop } from '../src/loop.ts';

/** requestAnimationFrame driven by the fake clock: callbacks fire every 16 ms of fake time, with that time as the timestamp. */
let now = 0;
beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => { now += 16; cb(now); }, 16) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fixed-timestep loop (accumulator)', () => {
  test('simulation runs at its own rate regardless of frame rate: ~60 steps per fake second at 62.5 fps', () => {
    let steps = 0;
    const loop = createLoop({ update: () => steps++, render: () => {} });
    loop.start();
    vi.advanceTimersByTime(2000);
    loop.stop();
    expect(steps).toBeGreaterThanOrEqual(115);
    expect(steps).toBeLessThanOrEqual(125);
  });

  test('alpha is the leftover fraction of a step, always in [0, 1)', () => {
    const alphas: number[] = [];
    const loop = createLoop({ update: () => {}, render: (a) => alphas.push(a) });
    loop.start();
    vi.advanceTimersByTime(500);
    loop.stop();
    expect(alphas.length).toBeGreaterThan(10);
    for (const a of alphas) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
  });

  test('a long pause (hidden tab) is clamped: no spiral of death', () => {
    let steps = 0;
    const loop = createLoop({ update: () => steps++, render: () => {} });
    loop.start();
    vi.advanceTimersByTime(32); // two frames, establishes lastTime
    steps = 0;
    now += 60_000; // the tab was hidden for a minute; the next rAF timestamp jumps
    vi.advanceTimersByTime(16);
    loop.stop();
    expect(steps).toBeLessThanOrEqual(Math.ceil(0.25 / (1 / 60)) + 1);
  });

  test('custom timestep (network client uses 1/30) and stop() really stops', () => {
    let steps = 0;
    const loop = createLoop({ update: () => steps++, render: () => {}, timestep: 1 / 30 });
    loop.start();
    loop.start(); // second start is a no-op, must not double the rate
    vi.advanceTimersByTime(1000);
    loop.stop();
    const atStop = steps;
    expect(atStop).toBeGreaterThanOrEqual(27);
    expect(atStop).toBeLessThanOrEqual(33);
    vi.advanceTimersByTime(1000);
    expect(steps).toBe(atStop);
  });

  test('HUD metrics update once per second', () => {
    const seen: number[] = [];
    const loop = createLoop({ update: () => {}, render: (_a, m) => seen.push(m.stepsPerSecond) });
    loop.start();
    vi.advanceTimersByTime(2500);
    loop.stop();
    expect(seen[0]).toBe(0);
    expect(Math.max(...seen)).toBeGreaterThan(50);
  });
});
