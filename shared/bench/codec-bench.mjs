// JSON vs binary wire size and CPU for the same snapshots. Run: npm run bench -w shared
import { makeWorld, run } from '../test/helpers.js';
import { snapshotEntities } from '../src/state.js';
import { codecs } from '../src/codec/index.js';
import { TICK_RATE } from '../src/constants.js';

const PLAYERS = 4;
const { world, shipIds } = makeWorld({ ships: PLAYERS, asteroids: 12 });
const snaps = [];
for (let i = 0; i < 300; i++) {
  run(world, shipIds, 1);
  snaps.push({ tick: world.tick, ack: world.tick, ents: snapshotEntities(world) });
}
const round = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
const roundedSnap = (s) => ({ ...s, ents: s.ents.map((e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, round(v)]))) });
const rows = [];

function measure(label, encode, decode, input = snaps) {
  let bytes = 0;
  for (const s of input) bytes += (encode(s).byteLength ?? encode(s).length);
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
console.log(`${PLAYERS} players, ${snaps[0].ents.length}..${snaps.at(-1).ents.length} entities, ${TICK_RATE} snapshots/s`);
console.table(rows);

const inputs = [1, 2, 3].map((seq) => ({ seq, thrust: true, turn: 1, fire: false }));
const pj = codecs.json.encodeInputPacket({ tick: 100, inputs });
const pb = codecs.binary.encodeInputPacket({ tick: 100, inputs });
console.log(`input packet (3 inputs): json ${pj.length} B, binary ${pb.byteLength} B  ->  up ${((pj.length * TICK_RATE) / 1024).toFixed(2)} vs ${((pb.byteLength * TICK_RATE) / 1024).toFixed(2)} KB/s`);
