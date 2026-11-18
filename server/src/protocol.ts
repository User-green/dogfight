// Server-side protocol glue. The SCHEMAS live in shared/src/protocol.ts (one source of truth for both ends);
// this file only adds what is server-specific: close codes, the typed outgoing-message builders and REST validation.
import {
  CreateRoomSchema,
  MAX_CHAT,
  MAX_NAME,
  PROTOCOL_VERSION,
  err,
  ok,
  parseClientText,
  type ClientMessage,
  type CreateRoom,
  type Result,
  type RoomInfo,
  type RosterEntry,
  type ServerMessage,
  type WireData,
} from 'shared/protocol';

export { PROTOCOL_VERSION, MAX_NAME, MAX_CHAT };

// WebSocket close codes in the 4000-4999 range are free for applications.
export const CloseCode = Object.freeze({
  GOING_AWAY: 1001,
  TOO_BIG: 1009,
  BAD_PROTOCOL: 4000,
  JOIN_TIMEOUT: 4001,
  RATE_LIMIT: 4002,
  ROOM_FULL: 4003,
  NO_SUCH_ROOM: 4004,
  SLOW_CLIENT: 4005,
} as const);
export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode];

/** Text frame from a client -> a validated message, or a short reason. Never throws, never trusts the shape. */
export function validate(data: WireData): Result<ClientMessage> {
  return parseClientText(data);
}

/** Validate the body of POST /api/rooms. */
export function validateCreateRoom(body: unknown): Result<CreateRoom> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return err('not-object');
  const r = CreateRoomSchema.safeParse(body);
  if (r.success) return ok(r.data);
  const key = r.error.issues[0]?.path[0];
  return err(key === 'asteroids' ? 'bad-asteroids' : 'bad-name');
}

type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
type WelcomeExtra = Omit<Of<'welcome'>, 'v' | 'type' | 'id' | 'room'>;

/** Every outgoing control message is built here, and the compiler checks it against the schema's inferred type. */
export const out = {
  welcome: (id: string, room: RoomInfo, extra: WelcomeExtra): string => JSON.stringify({ v: PROTOCOL_VERSION, type: 'welcome', id, room, ...extra } satisfies Of<'welcome'>),
  pong: (t: number): string => JSON.stringify({ v: PROTOCOL_VERSION, type: 'pong', t } satisfies Of<'pong'>),
  error: (reason: string): string => JSON.stringify({ v: PROTOCOL_VERSION, type: 'error', reason } satisfies Of<'error'>),
  roster: (players: RosterEntry[]): string => JSON.stringify({ v: PROTOCOL_VERSION, type: 'roster', players } satisfies Of<'roster'>),
  chat: (from: string, text: string): string => JSON.stringify({ v: PROTOCOL_VERSION, type: 'chat', from, text } satisfies Of<'chat'>),
  shutdown: (): string => JSON.stringify({ v: PROTOCOL_VERSION, type: 'shutdown' } satisfies Of<'shutdown'>),
};
