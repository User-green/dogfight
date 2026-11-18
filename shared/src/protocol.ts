// Network protocol shared by client and server: ONE definition of every message.
//
// Control messages (join, chat, ping, ...) are JSON text frames: {v:1, type, ...}.
// The two hot messages, `input` (up) and `snapshot` (down), go through a codec: JSON text or binary frames.
//
// zod schemas are the single source of truth: the TypeScript types are INFERRED from them (`z.infer`),
// so the type and the runtime check cannot drift apart. Types are erased at runtime; these schemas are
// what actually stands between a hostile client and the simulation.
import { z } from 'zod';
import { Kind } from './sim/entity.ts';
import { asEntityId, asSeq, asTick, assertNever } from './types.ts';
import type { EntityId, Seq, Tick } from './types.ts';

export const PROTOCOL_VERSION = 1;

/** First byte of every binary frame. */
export const BinType = Object.freeze({ INPUT: 1, SNAPSHOT: 2 } as const);
export const BINARY_VERSION = 1; // second byte; bump when the layout changes

export const MAX_INPUTS_PER_PACKET = 8;
export const MAX_NAME = 16;
export const MAX_CHAT = 200;

/** Latency / jitter / loss injector limits (dev and tests only). */
export const NETSIM_LIMITS = Object.freeze({ lag: 2000, jitter: 1000, drop: 100 });

export const CODEC_NAMES = ['json', 'binary'] as const;
export type CodecName = (typeof CODEC_NAMES)[number];

const U32_MAX = 0xffffffff;

// ---- branded primitives: validated here, branded here (the only place raw numbers become ids) ----------
const seqSchema = z.int().min(1).max(U32_MAX).transform(asSeq);
const ackSchema = z.int().min(0).max(U32_MAX).transform(asSeq); // 0 = "nothing processed yet"
const tickSchema = z.int().min(0).max(U32_MAX).transform(asTick);
const entityIdSchema = z.int().min(0).max(U32_MAX).transform(asEntityId);

// ---- input (client -> server) --------------------------------------------------------------------------
/** Anything outside the contract is rejected, never clamped: a turn of 1000 is not "a fast turn", it is a cheat or a bug. */
export const InputSchema = z.object({
  seq: seqSchema,
  thrust: z.boolean(),
  turn: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  fire: z.boolean(),
});
export type Input = z.infer<typeof InputSchema>;

const strictlyIncreasing = (inputs: readonly Input[]): boolean => inputs.every((i, k) => k === 0 || i.seq > (inputs[k - 1]?.seq ?? 0));

export const InputPacketSchema = z.object({
  tick: tickSchema,
  inputs: z.array(InputSchema).min(1).max(MAX_INPUTS_PER_PACKET).refine(strictlyIncreasing, 'seq must be strictly increasing'),
});
export type InputPacket = z.infer<typeof InputPacketSchema>;

// ---- replicated entity state: a discriminated union on `kind` ------------------------------------------
const num = z.number();
const base = { id: entityIdSchema, x: num, y: num } as const;

export const ShipStateSchema = z.object({
  ...base, kind: z.literal(Kind.SHIP), vx: num, vy: num, a: num, hp: z.int().min(0).max(255), alive: z.boolean(), thrust: z.boolean(),
  cd: num, inv: num, rap: num, score: z.int().min(0).max(U32_MAX),
});
export const BulletStateSchema = z.object({ ...base, kind: z.literal(Kind.BULLET), vx: num, vy: num, ttl: num, shooter: entityIdSchema, fseq: ackSchema });
export const AsteroidStateSchema = z.object({ ...base, kind: z.literal(Kind.ASTEROID), vx: num, vy: num, a: num, tier: z.union([z.literal(1), z.literal(2), z.literal(3)]) });
export const PickupStateSchema = z.object({ ...base, kind: z.literal(Kind.PICKUP), ptype: z.int().min(0).max(1) });

export const EntityStateSchema = z.discriminatedUnion('kind', [ShipStateSchema, BulletStateSchema, AsteroidStateSchema, PickupStateSchema]);
export type ShipState = z.infer<typeof ShipStateSchema>;
export type BulletState = z.infer<typeof BulletStateSchema>;
export type AsteroidState = z.infer<typeof AsteroidStateSchema>;
export type PickupState = z.infer<typeof PickupStateSchema>;
export type EntityState = z.infer<typeof EntityStateSchema>;

export const SnapshotSchema = z.object({ tick: tickSchema, ack: ackSchema, ents: z.array(EntityStateSchema) });
export type Snapshot = z.infer<typeof SnapshotSchema>;

// ---- control messages ------------------------------------------------------------------------------------
const NAME_RE = /^[\p{L}\p{N} _.-]{1,16}$/u;
const ROOM_RE = /^[a-z0-9-]{1,24}$/;
const v = z.literal(PROTOCOL_VERSION);

const netsimField = (max: number) => z.number().min(0).max(max).default(0);

export const JoinSchema = z.object({ v, type: z.literal('join'), room: z.string().regex(ROOM_RE), name: z.string().regex(NAME_RE), codec: z.enum(CODEC_NAMES).default('json') });
export const ChatSchema = z.object({ v, type: z.literal('chat'), text: z.string().min(1).max(MAX_CHAT) });
export const InputMessageSchema = z.object({ v, type: z.literal('input'), ...InputPacketSchema.shape });
export const PingSchema = z.object({ v, type: z.literal('ping'), t: num });
export const NetsimSchema = z.object({
  v, type: z.literal('netsim'), lag: netsimField(NETSIM_LIMITS.lag), jitter: netsimField(NETSIM_LIMITS.jitter), drop: netsimField(NETSIM_LIMITS.drop),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [JoinSchema, ChatSchema, InputMessageSchema, PingSchema, NetsimSchema]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const RoomInfoSchema = z.object({ id: z.string(), name: z.string(), players: z.int(), maxPlayers: z.int(), asteroids: z.int() });
export type RoomInfo = z.infer<typeof RoomInfoSchema>;
const RosterEntrySchema = z.object({ id: z.string(), name: z.string() });
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

export const WelcomeSchema = z.object({
  v, type: z.literal('welcome'), id: z.string(), room: RoomInfoSchema, shipId: entityIdSchema, tickRate: num,
  arena: z.object({ width: num, height: num }), codec: z.enum(CODEC_NAMES), netsim: z.boolean(),
});
export const ServerMessageSchema = z.discriminatedUnion('type', [
  WelcomeSchema,
  z.object({ v, type: z.literal('pong'), t: num }),
  z.object({ v, type: z.literal('error'), reason: z.string() }),
  z.object({ v, type: z.literal('roster'), players: z.array(RosterEntrySchema) }),
  z.object({ v, type: z.literal('chat'), from: z.string(), text: z.string() }),
  z.object({ v, type: z.literal('shutdown') }),
  z.object({ v, type: z.literal('snapshot'), ...SnapshotSchema.shape }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type Welcome = z.infer<typeof WelcomeSchema>;

// ---- results and parsing: bad input is a VALUE, never an exception -------------------------------------
export type Result<T, E = string> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Short machine-readable reason for the first problem zod found (these strings go to logs and close frames). */
function reasonOf(error: z.ZodError, data: unknown): string {
  const issue = error.issues[0];
  const key = issue?.path[0];
  if (issue === undefined) return 'invalid';
  if (issue.code === 'invalid_union' && key === 'type') return 'unknown-type';
  if (key === 'v') return 'bad-version';
  const type = typeof data === 'object' && data !== null && 'type' in data ? data.type : undefined;
  switch (type) {
    case 'join': return key === 'codec' ? 'bad-codec' : key === 'room' ? 'bad-room' : 'bad-name';
    case 'chat': return 'bad-text';
    case 'input': return 'bad-input';
    case 'ping': return 'bad-ping';
    case 'netsim': return 'bad-netsim';
    default: return 'invalid';
  }
}

/** Raw bytes or text off a socket. */
export type WireData = string | ArrayBuffer | ArrayBufferView;

export function wireToText(data: WireData): string {
  if (typeof data === 'string') return data;
  // ArrayBuffer / Uint8Array / Buffer: normalise to a Uint8Array that respects byteOffset (a Buffer is a slice of a pool)
  const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  return new TextDecoder().decode(bytes);
}

/** Parse JSON without throwing: `unknown` is exactly what `JSON.parse` gives us. */
export function parseJson(data: WireData): Result<unknown> {
  try {
    return ok(JSON.parse(wireToText(data)));
  } catch {
    return err('not-json');
  }
}

/** Validate an already-parsed value (e.g. a JSON.parse result) as a client message. Never throws. */
export function parseClientMessage(data: unknown): Result<ClientMessage> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return err('not-object');
  const r = ClientMessageSchema.safeParse(data);
  return r.success ? ok(r.data) : err(reasonOf(r.error, data));
}

export function parseServerMessage(data: unknown): Result<ServerMessage> {
  const r = ServerMessageSchema.safeParse(data);
  return r.success ? ok(r.data) : err(r.error.issues[0]?.message ?? 'invalid');
}

/** Text frame -> client message in one step. */
export function parseClientText(data: WireData): Result<ClientMessage> {
  const j = parseJson(data);
  return j.ok ? parseClientMessage(j.value) : j;
}

/** Input state of the ship as `World.step` / `Ship.step` want it. */
export const toShipInput = (i: Input) => ({ thrust: i.thrust, rotateLeft: i.turn < 0, rotateRight: i.turn > 0, fire: i.fire, seq: i.seq });

export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodecError';
  }
}

/** Exhaustive helper for protocol switches: put in `default`. */
export const unreachable = assertNever;
export type { EntityId, Seq, Tick };

/** A codec turns the two hot messages into wire frames and back. JSON and binary are two implementations. */
export interface Codec {
  readonly name: CodecName;
  encodeInputPacket(p: InputPacket): string | ArrayBuffer;
  decodeInputPacket(data: WireData): InputPacket;
  encodeSnapshot(s: Snapshot): string | ArrayBuffer;
  decodeSnapshot(data: WireData): Snapshot;
}

// ---- validation helpers for the REST body --------------------------------------------------------------
export const CreateRoomSchema = z.object({ name: z.string().min(1).max(24), asteroids: z.int().min(1).max(12).default(4) });
export type CreateRoom = z.infer<typeof CreateRoomSchema>;
