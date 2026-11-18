// JSON codec: the baseline. Text frames, numbers as decimal strings.
import { CodecError, PROTOCOL_VERSION, sanitizeInputPacket } from '../protocol.js';

export const name = 'json';

const toText = (data) => {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return new TextDecoder().decode(data); // Uint8Array / Buffer
};

const parse = (data, type) => {
  let msg;
  try {
    msg = JSON.parse(toText(data));
  } catch {
    throw new CodecError('not-json');
  }
  if (typeof msg !== 'object' || msg === null || msg.v !== PROTOCOL_VERSION || msg.type !== type) throw new CodecError(`not-a-${type}`);
  return msg;
};

export const encodeInputPacket = ({ tick, inputs }) => JSON.stringify({ v: PROTOCOL_VERSION, type: 'input', tick, inputs });

export function decodeInputPacket(data) {
  const clean = sanitizeInputPacket(parse(data, 'input'));
  if (!clean) throw new CodecError('invalid-input');
  return clean;
}

export const encodeSnapshot = ({ tick, ack, ents }) => JSON.stringify({ v: PROTOCOL_VERSION, type: 'snapshot', tick, ack, ents });

export function decodeSnapshot(data) {
  const { tick, ack, ents } = parse(data, 'snapshot');
  if (!Array.isArray(ents)) throw new CodecError('bad-snapshot');
  return { tick, ack, ents };
}
