// JSON codec: the baseline. Text frames, numbers as decimal strings.
import { CodecError, InputMessageSchema, PROTOCOL_VERSION, SnapshotSchema, parseJson } from '../protocol.ts';
import type { Codec, InputPacket, Snapshot, WireData } from '../protocol.ts';
import { z } from 'zod';

export const name = 'json';

const SnapshotMessage = z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal('snapshot'), ...SnapshotSchema.shape });

export const encodeInputPacket = ({ tick, inputs }: InputPacket): string => JSON.stringify({ v: PROTOCOL_VERSION, type: 'input', tick, inputs });

export function decodeInputPacket(data: WireData): InputPacket {
  const j = parseJson(data);
  if (!j.ok) throw new CodecError(j.error);
  const r = InputMessageSchema.safeParse(j.value);
  if (!r.success) throw new CodecError('invalid-input');
  return { tick: r.data.tick, inputs: r.data.inputs };
}

export const encodeSnapshot = ({ tick, ack, ents }: Snapshot): string => JSON.stringify({ v: PROTOCOL_VERSION, type: 'snapshot', tick, ack, ents });

export function decodeSnapshot(data: WireData): Snapshot {
  const j = parseJson(data);
  if (!j.ok) throw new CodecError(j.error);
  const r = SnapshotMessage.safeParse(j.value);
  if (!r.success) throw new CodecError('bad-snapshot');
  return { tick: r.data.tick, ack: r.data.ack, ents: r.data.ents };
}

/** Compile-time check that this module really implements `Codec` (no cast: `satisfies` only verifies). */
export const codec = { name, encodeInputPacket, decodeInputPacket, encodeSnapshot, decodeSnapshot } as const satisfies Codec;
