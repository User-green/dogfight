import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { ARENA, TICK_DT } from '../src/constants.ts';
import { toShipInput } from '../src/protocol.ts';
import type { Input } from '../src/protocol.ts';
import { Ship } from '../src/sim/ship.ts';
import { Vector2 } from '../src/sim/vector.ts';
import { World } from '../src/sim/world.ts';
import { applyState, entityState } from '../src/state.ts';
import { Kind } from '../src/sim/entity.ts';
import { asSeq } from '../src/types.ts';

const inputArb = fc.record({ thrust: fc.boolean(), turn: fc.constantFrom(-1, 0, 1) as fc.Arbitrary<-1 | 0 | 1>, fire: fc.boolean() });
const withSeq = (xs: { thrust: boolean; turn: -1 | 0 | 1; fire: boolean }[], from: number): Input[] => xs.map((x, i) => ({ seq: asSeq(from + i), ...x }));

/**
 * Client-side reconciliation is "take the server state at the acknowledged tick, replay the unacknowledged inputs".
 * It is only correct if replaying from a snapshot gives the same ship as the server reached by simulating straight through.
 */
describe('reconciliation is pure replay', () => {
  test('snapshot at tick k + replay of inputs k..n == authoritative ship at n (any inputs, any split point)', () => {
    fc.assert(
      fc.property(fc.array(inputArb, { minLength: 2, maxLength: 120 }), fc.nat(), (script, cut) => {
        const inputs = withSeq(script, 1);
        const k = cut % inputs.length;

        const world = new World({ seed: 5 });
        const authoritative = world.spawn(new Ship({ pos: new Vector2(ARENA.width / 2, ARENA.height / 2) }));
        let atCut: ReturnType<typeof entityState> = null;
        inputs.forEach((i, idx) => {
          if (idx === k) atCut = entityState(authoritative);
          world.step(TICK_DT, ARENA, new Map([[authoritative.id, toShipInput(i)]]));
        });
        if (atCut === null) throw new Error('cut state missing');

        const predicted = new Ship({ id: authoritative.id });
        applyState(predicted, atCut);
        for (const i of inputs.slice(k)) {
          predicted.step(TICK_DT, toShipInput(i), ARENA);
          if (i.fire) predicted.fire({ spawn: (b) => b });
        }

        const want = entityState(authoritative);
        const got = entityState(predicted);
        expect(got?.kind).toBe(Kind.SHIP);
        if (want?.kind !== Kind.SHIP || got?.kind !== Kind.SHIP) return;
        // the server reached `want` through collisions-free straight simulation; the replay must match to float precision
        expect(got.x).toBeCloseTo(want.x, 6);
        expect(got.y).toBeCloseTo(want.y, 6);
        expect(got.vx).toBeCloseTo(want.vx, 6);
        expect(got.vy).toBeCloseTo(want.vy, 6);
        expect(got.a).toBeCloseTo(want.a, 6);
      }),
      { numRuns: 100 },
    );
  });
});
