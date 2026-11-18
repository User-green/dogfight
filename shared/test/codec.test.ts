import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codecs } from '../src/codec/index.ts';
import * as binary from '../src/codec/binary.ts';
import * as json from '../src/codec/json.ts';
import { CodecError, type EntityState, type InputPacket, type Snapshot } from '../src/protocol.ts';
import { asEntityId, asSeq, asTick } from '../src/types.ts';
import { makeWorld, run } from './helpers.ts';
import { snapshotEntities } from '../src/state.ts';
import { Kind } from '../src/sim/entity.ts';

const input: InputPacket = {
  tick: asTick(99),
  inputs: [
    { seq: asSeq(5), thrust: true, turn: -1, fire: false },
    { seq: asSeq(6), thrust: false, turn: 1, fire: true },
    { seq: asSeq(9), thrust: true, turn: 0, fire: true },
  ],
};

function sampleSnapshot(): Snapshot {
  const { world, shipIds } = makeWorld({ ships: 4, asteroids: 5 });
  run(world, shipIds, 120); // fire bullets, spin angles past PI
  return { tick: world.tick, ack: asSeq(117), ents: snapshotEntities(world) };
}

// quantization tolerances, from the spec
const TOL = { f32: 1e-3, angle: 0.0005 + 1e-9, cd: 0.0005 + 1e-9, cs: 0.005 + 1e-9 };
type Fields = Record<string, number | boolean>;
const close = (x: unknown, y: unknown, tol: number): boolean => typeof x === 'number' && typeof y === 'number' && Math.abs(x - y) <= tol;

function assertEntityClose(ea: EntityState, eb: EntityState): void {
  const a: Fields = { ...ea };
  const b: Fields = { ...eb };
  assert.equal(a['id'], b['id']);
  assert.equal(a['kind'], b['kind']);
  for (const k of ['x', 'y', 'vx', 'vy']) if (k in a) assert.ok(close(a[k], b[k], TOL.f32), `${k}: ${a[k]} vs ${b[k]}`);
  if ('a' in a) assert.ok(close(a['a'], b['a'], TOL.angle), `angle ${a['a']} vs ${b['a']}`);
  for (const k of ['hp', 'alive', 'thrust', 'score', 'shooter', 'fseq', 'tier', 'ptype']) if (k in a) assert.equal(a[k], b[k], k);
  if ('cd' in a) assert.ok(close(a['cd'], b['cd'], TOL.cd));
  if ('ttl' in a) assert.ok(close(a['ttl'], b['ttl'], TOL.cd));
  for (const k of ['inv', 'rap']) if (k in a) assert.ok(close(a[k], b[k], TOL.cs), k);
}

for (const [name, codec] of Object.entries(codecs)) {
  test(`${name}: input packet round-trips exactly`, () => {
    assert.deepEqual(codec.decodeInputPacket(codec.encodeInputPacket(input)), input);
  });
  test(`${name}: snapshot round-trips within quantization tolerance`, () => {
    const snap = sampleSnapshot();
    const back = codec.decodeSnapshot(codec.encodeSnapshot(snap));
    assert.equal(back.tick, snap.tick);
    assert.equal(back.ack, snap.ack);
    assert.equal(back.ents.length, snap.ents.length);
    snap.ents.forEach((e, i) => {
      const other = back.ents[i];
      assert.ok(other);
      assertEntityClose(e, other);
    });
  });
}

test('sample snapshot really contains every replicated kind', () => {
  const kinds = new Set(sampleSnapshot().ents.map((e) => e.kind));
  for (const k of [Kind.SHIP, Kind.BULLET, Kind.ASTEROID, Kind.PICKUP]) assert.ok(kinds.has(k), `kind ${k} missing`);
});

test('binary: sizes match the written spec', () => {
  assert.equal(binary.encodeInputPacket(input).byteLength, 2 + 4 + 1 + 5 * 3);
  const snap = sampleSnapshot();
  const expected = 12 + snap.ents.reduce((n, e) => n + 5 + { 1: 30, 2: 26, 3: 19, 4: 9 }[e.kind], 0);
  assert.equal(binary.encodeSnapshot(snap).byteLength, expected);
});

test('binary: little-endian on the wire (tick 0x01020304 => bytes 04 03 02 01)', () => {
  const bytes = new Uint8Array(binary.encodeSnapshot({ tick: asTick(0x01020304), ack: asSeq(0), ents: [] }));
  assert.deepEqual([...bytes.slice(0, 6)], [2, 1, 0x04, 0x03, 0x02, 0x01]);
});

test('binary: angles beyond +-PI are normalized, not overflowed (i16 holds +-32.767 rad only)', () => {
  const ent: EntityState = { id: asEntityId(1), kind: Kind.ASTEROID, x: 1, y: 2, vx: 0, vy: 0, a: 100.5, tier: 2 };
  const back = binary.decodeSnapshot(binary.encodeSnapshot({ tick: asTick(1), ack: asSeq(0), ents: [ent] })).ents[0];
  assert.ok(back && back.kind === Kind.ASTEROID);
  assert.ok(Math.abs(Math.sin(back.a) - Math.sin(100.5)) < 1e-3 && Math.abs(Math.cos(back.a) - Math.cos(100.5)) < 1e-3);
});

test('binary: a Node Buffer that is a slice of a larger pool decodes correctly (byteOffset matters)', () => {
  const snap = sampleSnapshot();
  const bytes = Buffer.from(binary.encodeSnapshot(snap));
  const pool = Buffer.alloc(bytes.length + 37, 0xee);
  bytes.copy(pool, 37);
  const slice = pool.subarray(37); // buffer.buffer is the WHOLE pool; byteOffset is 37
  assert.deepEqual(binary.decodeSnapshot(slice), binary.decodeSnapshot(bytes));
});

test('binary: malformed frames throw CodecError, never anything else', () => {
  const good = new Uint8Array(binary.encodeSnapshot(sampleSnapshot()));
  const goodIn = new Uint8Array(binary.encodeInputPacket(input));
  const bad = (label: string, fn: () => unknown): void => assert.throws(fn, CodecError, label);
  bad('truncated', () => binary.decodeSnapshot(good.slice(0, good.length - 3)));
  bad('empty', () => binary.decodeSnapshot(new Uint8Array(0)));
  bad('trailing', () => binary.decodeSnapshot(Uint8Array.from([...good, 0])));
  bad('wrong type', () => binary.decodeSnapshot(goodIn));
  bad('bad version', () => binary.decodeSnapshot(Uint8Array.from([2, 9, ...good.slice(2)])));
  bad('lying count', () => binary.decodeSnapshot(Uint8Array.from([...good.slice(0, 10), 0xff, 0xff, ...good.slice(12)])));
  bad('input truncated', () => binary.decodeInputPacket(goodIn.slice(0, 10)));
  bad('input count 0', () => binary.decodeInputPacket(Uint8Array.from([1, 1, 0, 0, 0, 0, 0])));
  bad('input count 200', () => binary.decodeInputPacket(Uint8Array.from([1, 1, 0, 0, 0, 0, 200, ...new Array(1000).fill(1)])));
  const turn3 = Uint8Array.from(goodIn);
  turn3[11] = 0b1100; // turn bits = 3
  bad('turn 3', () => binary.decodeInputPacket(turn3));
  const nonMono = Uint8Array.from(goodIn);
  nonMono[12] = 1; // second seq < first
  nonMono[13] = 0;
  nonMono[14] = 0;
  nonMono[15] = 0;
  bad('non-increasing seq', () => binary.decodeInputPacket(nonMono));
  // fuzz: random garbage must never throw anything but CodecError
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let n = 0; n < 2000; n++) {
    const junk = Uint8Array.from({ length: Math.floor(rnd() * 80) }, () => Math.floor(rnd() * 256));
    for (const fn of [binary.decodeSnapshot, binary.decodeInputPacket]) {
      try {
        fn(junk);
      } catch (e) {
        assert.ok(e instanceof CodecError, `unexpected ${e}`);
      }
    }
  }
});

test('json: server-side validation rejects cheats (turn 1000, NaN, fractional seq, missing fields)', () => {
  const mk = (i: unknown): string => JSON.stringify({ v: 1, type: 'input', tick: 1, inputs: [i] });
  const okInput = { seq: 1, thrust: true, turn: 0, fire: false };
  assert.doesNotThrow(() => json.decodeInputPacket(mk(okInput)));
  for (const cheat of [{ ...okInput, turn: 1000 }, { ...okInput, turn: 0.5 }, { ...okInput, seq: 1.5 }, { ...okInput, seq: 0 }, { ...okInput, thrust: 1 }, { seq: 1 }, null]) {
    assert.throws(() => json.decodeInputPacket(mk(cheat)), CodecError, JSON.stringify(cheat));
  }
  assert.throws(() => json.decodeInputPacket('{not json'), CodecError);
  assert.throws(() => json.decodeInputPacket(JSON.stringify({ v: 1, type: 'input', tick: 1, inputs: Array.from({ length: 50 }, (_, k) => ({ ...okInput, seq: k + 1 })) })), CodecError);
});
