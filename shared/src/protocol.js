// Network protocol shared by client and server.
//
// Control messages (join, chat, ping, ...) are always JSON text frames: {v:1, type, ...}.
// The two hot messages, `input` (up) and `snapshot` (down), go through a codec: JSON text or binary frames.
export const PROTOCOL_VERSION = 1;

/** First byte of every binary frame. */
export const BinType = Object.freeze({ INPUT: 1, SNAPSHOT: 2 });
export const BINARY_VERSION = 1; // second byte; bump when the layout changes

export const MAX_INPUTS_PER_PACKET = 8;

/**
 * Validate ONE input. Anything outside the contract returns null. Never clamp: a turn of 1000 is not
 * "a fast turn", it is a cheat or a bug, and the whole packet is dropped.
 * @returns {{seq:number, thrust:boolean, turn:-1|0|1, fire:boolean}|null}
 */
export function sanitizeInput(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const { seq, thrust, turn, fire } = raw;
  if (!Number.isInteger(seq) || seq < 1 || seq > 0xffffffff) return null;
  if (typeof thrust !== 'boolean' || typeof fire !== 'boolean') return null;
  if (!Number.isInteger(turn) || turn < -1 || turn > 1) return null;
  return { seq, thrust, turn, fire };
}

/** @returns {{tick:number, inputs:object[]}|null} */
export function sanitizeInputPacket(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  if (!Number.isInteger(raw.tick) || raw.tick < 0 || raw.tick > 0xffffffff) return null;
  if (!Array.isArray(raw.inputs) || raw.inputs.length < 1 || raw.inputs.length > MAX_INPUTS_PER_PACKET) return null;
  const inputs = [];
  for (const i of raw.inputs) {
    const clean = sanitizeInput(i);
    if (!clean) return null;
    if (inputs.length && clean.seq <= inputs.at(-1).seq) return null; // must be strictly increasing
    inputs.push(clean);
  }
  return { tick: raw.tick, inputs };
}

/** Input state of the ship as `World.step` / `Ship.update` want it. */
export const toShipInput = (i) => ({ thrust: i.thrust, rotateLeft: i.turn < 0, rotateRight: i.turn > 0, fire: i.fire, seq: i.seq });

export class CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodecError';
  }
}
