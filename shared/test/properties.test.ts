import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import * as binary from '../src/codec/binary.ts';
import { ARENA, TICK_DT } from '../src/constants.ts';
import { CodecError, MAX_INPUTS_PER_PACKET, parseClientMessage, toShipInput } from '../src/protocol.ts';
import type { Input, InputPacket } from '../src/protocol.ts';
import { asSeq, asTick } from '../src/types.ts';
import { snapshotEntities } from '../src/state.ts';
import { makeWorld } from './helpers.ts';

const turn = fc.constantFrom(-1, 0, 1) as fc.Arbitrary<-1 | 0 | 1>;

/** Strictly increasing seqs: generate positive gaps, then take the running sum. */
const inputPacket: fc.Arbitrary<InputPacket> = fc
  .record({
    tick: fc.integer({ min: 0, max: 0xffffffff }),
    gaps: fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: MAX_INPUTS_PER_PACKET }),
    flags: fc.array(fc.record({ thrust: fc.boolean(), turn, fire: fc.boolean() }), { minLength: MAX_INPUTS_PER_PACKET, maxLength: MAX_INPUTS_PER_PACKET }),
  })
  .map(({ tick, gaps, flags }) => {
    let seq = 0;
    const inputs: Input[] = gaps.map((g, i) => {
      seq += g;
      return { seq: asSeq(seq), thrust: flags[i]?.thrust ?? false, turn: flags[i]?.turn ?? 0, fire: flags[i]?.fire ?? false };
    });
    return { tick: asTick(tick), inputs };
  });

describe('binary codec properties', () => {
  test('input packet: decode(encode(p)) deep-equals p (lossless)', () => {
    fc.assert(fc.property(inputPacket, (p) => {
      expect(binary.decodeInputPacket(binary.encodeInputPacket(p))).toEqual(p);
    }));
  });

  test('input packet: byte length is exactly 7 + 5n', () => {
    fc.assert(fc.property(inputPacket, (p) => {
      expect(binary.encodeInputPacket(p).byteLength).toBe(7 + 5 * p.inputs.length);
    }));
  });

  test('snapshot: round trip stays within the quantization tolerance, any seed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 4 }), fc.integer({ min: 0, max: 90 }), (seed, ships, ticks) => {
        const { world, shipIds } = makeWorld({ seed, ships, asteroids: 4 });
        for (let t = 0; t < ticks; t++) {
          const inputs = new Map(shipIds.map((id, k) => [id, toShipInput({ seq: asSeq(t + 1), thrust: (t + k) % 3 !== 0, turn: ((t + k) % 3) - 1 as -1 | 0 | 1, fire: t % 5 === 0 })]));
          world.step(TICK_DT, ARENA, inputs);
        }
        const snap = { tick: world.tick, ack: asSeq(1), ents: snapshotEntities(world) };
        const back = binary.decodeSnapshot(binary.encodeSnapshot(snap));
        expect(back.ents.length).toBe(snap.ents.length);
        snap.ents.forEach((e, i) => {
          const b = back.ents[i];
          expect(b?.id).toBe(e.id);
          expect(b?.kind).toBe(e.kind);
          expect(Math.abs((b?.x ?? NaN) - e.x)).toBeLessThanOrEqual(1e-3);
          expect(Math.abs((b?.y ?? NaN) - e.y)).toBeLessThanOrEqual(1e-3);
        });
      }),
      { numRuns: 40 },
    );
  });

  test('garbage bytes: decoders throw a typed CodecError, never anything else, never hang', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
      for (const decode of [binary.decodeInputPacket, binary.decodeSnapshot]) {
        try {
          decode(bytes);
        } catch (e) {
          expect(e).toBeInstanceOf(CodecError);
        }
      }
    }), { numRuns: 500 });
  });

  test('truncating a valid packet by any amount is a CodecError', () => {
    fc.assert(fc.property(inputPacket, fc.nat(), (p, cut) => {
      const buf = binary.encodeInputPacket(p);
      const short = buf.slice(0, cut % buf.byteLength);
      expect(() => binary.decodeInputPacket(short)).toThrow(CodecError);
    }));
  });
});

describe('simulation properties', () => {
  test('ships stay inside the arena over 1000 random steps (toroidal wrap)', () => {
    const step = fc.record({ thrust: fc.boolean(), turn, fire: fc.boolean() });
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), fc.array(step, { minLength: 1, maxLength: 40 }), (seed, script) => {
        const { world, shipIds } = makeWorld({ seed, ships: 2, asteroids: 3 });
        for (let t = 0; t < 1000; t++) {
          const s = script[t % script.length];
          if (s === undefined) continue;
          const inputs = new Map(shipIds.map((id, k) => [id, toShipInput({ seq: asSeq(t + 1), ...s, turn: k === 0 ? s.turn : (-s.turn as -1 | 0 | 1) })]));
          world.step(TICK_DT, ARENA, inputs);
        }
        for (const e of snapshotEntities(world)) {
          expect(e.x).toBeGreaterThanOrEqual(0);
          expect(e.x).toBeLessThanOrEqual(ARENA.width);
          expect(e.y).toBeGreaterThanOrEqual(0);
          expect(e.y).toBeLessThanOrEqual(ARENA.height);
        }
      }),
      { numRuns: 15 },
    );
  });
});

describe('protocol validation properties', () => {
  test('every generated valid input message is accepted', () => {
    fc.assert(fc.property(inputPacket, (p) => {
      expect(parseClientMessage({ v: 1, type: 'input', ...p }).ok).toBe(true);
    }));
  });

  test('breaking one field of a valid message is always rejected', () => {
    const mutation = fc.constantFrom<(m: Record<string, unknown>) => void>(
      (m) => { m['v'] = 2; },
      (m) => { m['type'] = 'nope'; },
      (m) => { m['inputs'] = []; },
      (m) => { m['tick'] = -1; },
      (m) => { m['tick'] = 1.5; },
      (m) => { (m['inputs'] as { turn: unknown }[])[0]!.turn = 7; },
      (m) => { (m['inputs'] as { seq: unknown }[])[0]!.seq = 0; },
      (m) => { (m['inputs'] as { thrust: unknown }[])[0]!.thrust = 'yes'; },
    );
    fc.assert(fc.property(inputPacket, mutation, (p, mutate) => {
      const msg = structuredClone({ v: 1, type: 'input', ...p }) as Record<string, unknown>;
      mutate(msg);
      expect(parseClientMessage(msg).ok).toBe(false);
    }));
  });

  test('arbitrary JSON values never make parseClientMessage throw', () => {
    fc.assert(fc.property(fc.anything(), (v) => {
      expect(() => parseClientMessage(v)).not.toThrow();
    }), { numRuns: 1000 });
  });
});
