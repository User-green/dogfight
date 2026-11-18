// JSON vs binary wire size and CPU for the same snapshots. Run: npm run bench -w shared
import { makeWorld, run } from '../test/helpers.ts';
import { snapshotEntities } from '../src/state.ts';
import { codecs } from '../src/codec/index.ts';
import { TICK_RATE } from '../src/constants.ts';
import { SnapshotSchema, type Snapshot } from '../src/protocol.ts';
import { asSeq, asTick } from '../src/types.ts';

const PLAYERS = 4;
const { world, shipIds } = makeWorld({ ships: PLAYERS, asteroids: 12 });
const snaps: Snapshot[] = [];
for (let i = 0; i < 300; i++) {
  run(world, shipIds, 1);
  snaps.push({ tick: world.tick, ack: asSeq(world.tick), ents: snapshotEntities(world) });
}
// Round every number to 3 dp, then re-validate through the schema so the result is a real Snapshot again (no cast).
const roundedSnap = (s: Snapshot): Snapshot => SnapshotSchema.parse(JSON.parse(JSON.stringify(s, (_k, v: unknown) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v))));
interface Row {
  codec: string;
  'bytes/snapshot': number;
  'KB/s per client (down)': number;
  'encode us': number;
  'decode us': number;
}
const rows: Row[] = [];
const size = (p: string | ArrayBuffer): number => (typeof p === 'string' ? p.length : p.byteLength);

function measure(label: string, encode: (s: Snapshot) => string | ArrayBuffer, decode: (p: string | ArrayBuffer) => unknown, input: readonly Snapshot[] = snaps): void {
  let bytes = 0;
  for (const s of input) bytes += size(encode(s));
  const avg = bytes / input.length;
  const REPS = 20;
  const t0 = performance.now();
  for (let r = 0; r < REPS; r++) for (const s of input) encode(s);
  const enc = ((performance.now() - t0) * 1000) / (REPS * input.length);
  const encoded = input.map(encode);
  const t1 = performance.now();
  for (let r = 0; r < REPS; r++) for (const p of encoded) decode(p);
  const dec = ((performance.now() - t1) * 1000) / (REPS * input.length);
  rows.push({ codec: label, 'bytes/snapshot': +avg.toFixed(0), 'KB/s per client (down)': +((avg * TICK_RATE) / 1024).toFixed(2), 'encode us': +enc.toFixed(1), 'decode us': +dec.toFixed(1) });
}
measure('json (full precision)', codecs.json.encodeSnapshot, codecs.json.decodeSnapshot);
measure('json (rounded to 3 dp)', codecs.json.encodeSnapshot, codecs.json.decodeSnapshot, snaps.map(roundedSnap));
measure('binary', codecs.binary.encodeSnapshot, codecs.binary.decodeSnapshot);
console.log(`${PLAYERS} players, ${snaps[0]?.ents.length}..${snaps.at(-1)?.ents.length} entities, ${TICK_RATE} snapshots/s`);
console.table(rows);

const inputs = [1, 2, 3].map((seq) => ({ seq: asSeq(seq), thrust: true, turn: 1 as const, fire: false }));
const pj = codecs.json.encodeInputPacket({ tick: asTick(100), inputs });
const pb = codecs.binary.encodeInputPacket({ tick: asTick(100), inputs });
console.log(`input packet (3 inputs): json ${size(pj)} B, binary ${size(pb)} B  ->  up ${((size(pj) * TICK_RATE) / 1024).toFixed(2)} vs ${((size(pb) * TICK_RATE) / 1024).toFixed(2)} KB/s`);
