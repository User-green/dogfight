// Binary codec over DataView. LITTLE-ENDIAN everywhere (every browser CPU we care about is little-endian,
// so there is no byte swapping; the point is that the format SAYS so instead of depending on the host).
//
// ============================== WIRE SPEC, version 1 ==============================
//
// Every frame:           u8 type | u8 version                       (type: 1 = input, 2 = snapshot)
//
// INPUT   (client -> server)
//   u32 tick             the newest server tick the client has seen
//   u8  count            1..8 inputs, OLDEST FIRST (redundancy: the last 3 inputs ride in every packet)
//   count x { u32 seq,   input sequence number, strictly increasing
//             u8  flags }   bit0 thrust | bit1 fire | bits2-3 turn+1 (0 = left, 1 = none, 2 = right; 3 is invalid)
//   size = 2 + 4 + 1 + 5*count   (3 inputs: 22 bytes)
//
// SNAPSHOT (server -> client)
//   u32 tick             server tick this state belongs to
//   u32 ack              last input seq the server applied for THIS client (lastProcessedSeq)
//   u16 count            number of entities
//   count x entity:  u32 id | u8 kind | payload
//     ship     (kind 1, 30 B payload): f32 x, y, vx, vy | i16 angle (1/1000 rad) | u8 hp
//                                      | u8 flags (bit0 alive, bit1 thrusting) | u16 cooldown (ms)
//                                      | u16 invuln (1/100 s) | u16 rapid (1/100 s) | u32 score
//     bullet   (kind 2, 26 B payload): f32 x, y, vx, vy | u16 ttl (ms) | u32 shooter id | u32 fireSeq
//     asteroid (kind 3, 19 B payload): f32 x, y, vx, vy | i16 angle (1/1000 rad) | u8 tier
//     pickup   (kind 4,  9 B payload): f32 x, y | u8 type (0 shield, 1 rapid fire)
//   size = 12 + sum(5 + payload)
//
// Quantization: angle = round(rad * 1000) in an i16. That is a step of 0.001 rad = 0.057 degrees; the worst
// error is 0.0005 rad, which moves the ship's nose (20 units out) by 0.01 units, a hundredth of a pixel.
// Positions and velocities stay f32 (24 bits of mantissa: 0.00006 units of error at 1000).
// ===================================================================================
import { BINARY_VERSION, BinType, CodecError, MAX_INPUTS_PER_PACKET } from '../protocol.js';
import { Kind } from '../sim/entity.js';
import { normAngle } from '../state.js';

export const name = 'binary';
const LE = true;
const clamp = (v, hi) => Math.min(hi, Math.max(0, Math.round(v)));

const PAYLOAD = { [Kind.SHIP]: 30, [Kind.BULLET]: 26, [Kind.ASTEROID]: 19, [Kind.PICKUP]: 9 };

/** A view that respects byteOffset: a Node Buffer is a slice of a shared pool, so `buf.buffer` alone is WRONG. */
function viewOf(data) {
  if (data instanceof ArrayBuffer) return new DataView(data);
  if (ArrayBuffer.isView(data)) return new DataView(data.buffer, data.byteOffset, data.byteLength);
  throw new CodecError('not-binary');
}

function header(view, type) {
  if (view.byteLength < 2) throw new CodecError('truncated');
  if (view.getUint8(0) !== type) throw new CodecError('wrong-type');
  if (view.getUint8(1) !== BINARY_VERSION) throw new CodecError('bad-version');
}

export function encodeInputPacket({ tick, inputs }) {
  const n = inputs.length;
  const buf = new ArrayBuffer(7 + 5 * n);
  const v = new DataView(buf);
  v.setUint8(0, BinType.INPUT);
  v.setUint8(1, BINARY_VERSION);
  v.setUint32(2, tick, LE);
  v.setUint8(6, n);
  let o = 7;
  for (const i of inputs) {
    v.setUint32(o, i.seq, LE);
    v.setUint8(o + 4, (i.thrust ? 1 : 0) | (i.fire ? 2 : 0) | ((i.turn + 1) << 2));
    o += 5;
  }
  return buf;
}

export function decodeInputPacket(data) {
  const v = viewOf(data);
  header(v, BinType.INPUT);
  if (v.byteLength < 7) throw new CodecError('truncated');
  const tick = v.getUint32(2, LE);
  const n = v.getUint8(6);
  if (n < 1 || n > MAX_INPUTS_PER_PACKET) throw new CodecError('bad-count');
  if (v.byteLength !== 7 + 5 * n) throw new CodecError('bad-length');
  const inputs = [];
  let o = 7;
  let last = 0;
  for (let k = 0; k < n; k++, o += 5) {
    const seq = v.getUint32(o, LE);
    const f = v.getUint8(o + 4);
    const turn = ((f >> 2) & 3) - 1;
    if (seq <= last || turn > 1 || f > 0x0b) throw new CodecError('invalid-input'); // strictly increasing; turn 3 and stray bits are invalid
    last = seq;
    inputs.push({ seq, thrust: (f & 1) === 1, turn, fire: (f & 2) === 2 });
  }
  return { tick, inputs };
}

export function encodeSnapshot({ tick, ack, ents }) {
  let size = 12;
  for (const e of ents) size += 5 + PAYLOAD[e.kind];
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  v.setUint8(0, BinType.SNAPSHOT);
  v.setUint8(1, BINARY_VERSION);
  v.setUint32(2, tick, LE);
  v.setUint32(6, ack, LE);
  v.setUint16(10, ents.length, LE);
  let o = 12;
  for (const e of ents) {
    v.setUint32(o, e.id, LE);
    v.setUint8(o + 4, e.kind);
    o += 5;
    v.setFloat32(o, e.x, LE);
    v.setFloat32(o + 4, e.y, LE);
    o += 8;
    switch (e.kind) {
      case Kind.SHIP:
        v.setFloat32(o, e.vx, LE);
        v.setFloat32(o + 4, e.vy, LE);
        v.setInt16(o + 8, Math.round(normAngle(e.a) * 1000), LE);
        v.setUint8(o + 10, e.hp);
        v.setUint8(o + 11, (e.alive ? 1 : 0) | (e.thrust ? 2 : 0));
        v.setUint16(o + 12, clamp(e.cd * 1000, 0xffff), LE);
        v.setUint16(o + 14, clamp(e.inv * 100, 0xffff), LE);
        v.setUint16(o + 16, clamp(e.rap * 100, 0xffff), LE);
        v.setUint32(o + 18, e.score >>> 0, LE);
        o += 22;
        break;
      case Kind.BULLET:
        v.setFloat32(o, e.vx, LE);
        v.setFloat32(o + 4, e.vy, LE);
        v.setUint16(o + 8, clamp(e.ttl * 1000, 0xffff), LE);
        v.setUint32(o + 10, e.shooter, LE);
        v.setUint32(o + 14, e.fseq, LE);
        o += 18;
        break;
      case Kind.ASTEROID:
        v.setFloat32(o, e.vx, LE);
        v.setFloat32(o + 4, e.vy, LE);
        v.setInt16(o + 8, Math.round(normAngle(e.a) * 1000), LE);
        v.setUint8(o + 10, e.tier);
        o += 11;
        break;
      case Kind.PICKUP:
        v.setUint8(o, e.ptype);
        o += 1;
        break;
    }
  }
  return buf;
}

export function decodeSnapshot(data) {
  const v = viewOf(data);
  header(v, BinType.SNAPSHOT);
  if (v.byteLength < 12) throw new CodecError('truncated');
  const tick = v.getUint32(2, LE);
  const ack = v.getUint32(6, LE);
  const count = v.getUint16(10, LE);
  const ents = [];
  let o = 12;
  for (let k = 0; k < count; k++) {
    if (o + 5 > v.byteLength) throw new CodecError('truncated');
    const id = v.getUint32(o, LE);
    const kind = v.getUint8(o + 4);
    const payload = PAYLOAD[kind];
    if (payload === undefined) throw new CodecError('unknown-kind');
    if (o + 5 + payload > v.byteLength) throw new CodecError('truncated');
    o += 5;
    const e = { id, kind, x: v.getFloat32(o, LE), y: v.getFloat32(o + 4, LE) };
    o += 8;
    switch (kind) {
      case Kind.SHIP: {
        const flags = v.getUint8(o + 11);
        e.vx = v.getFloat32(o, LE);
        e.vy = v.getFloat32(o + 4, LE);
        e.a = v.getInt16(o + 8, LE) / 1000;
        e.hp = v.getUint8(o + 10);
        e.alive = (flags & 1) === 1;
        e.thrust = (flags & 2) === 2;
        e.cd = v.getUint16(o + 12, LE) / 1000;
        e.inv = v.getUint16(o + 14, LE) / 100;
        e.rap = v.getUint16(o + 16, LE) / 100;
        e.score = v.getUint32(o + 18, LE);
        o += 22;
        break;
      }
      case Kind.BULLET:
        e.vx = v.getFloat32(o, LE);
        e.vy = v.getFloat32(o + 4, LE);
        e.ttl = v.getUint16(o + 8, LE) / 1000;
        e.shooter = v.getUint32(o + 10, LE);
        e.fseq = v.getUint32(o + 14, LE);
        o += 18;
        break;
      case Kind.ASTEROID:
        e.vx = v.getFloat32(o, LE);
        e.vy = v.getFloat32(o + 4, LE);
        e.a = v.getInt16(o + 8, LE) / 1000;
        e.tier = v.getUint8(o + 10);
        o += 11;
        break;
      case Kind.PICKUP:
        e.ptype = v.getUint8(o);
        o += 1;
        break;
    }
    ents.push(e);
  }
  if (o !== v.byteLength) throw new CodecError('trailing-bytes');
  return { tick, ack, ents };
}
