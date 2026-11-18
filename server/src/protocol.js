// Protocol v1: JSON messages with a `type` field. The server NEVER trusts message shape.
export const PROTOCOL_VERSION = 1;
export const MAX_NAME = 16;
export const MAX_CHAT = 200;

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
});

const NAME_RE = /^[\p{L}\p{N} _.-]{1,16}$/u;
const ROOM_RE = /^[a-z0-9-]{1,24}$/;

const isObj = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);

/** @returns {{ok:true,msg:object}|{ok:false,reason:string}} */
export function validate(data) {
  let msg;
  try {
    msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  if (!isObj(msg)) return { ok: false, reason: 'not-object' };
  if (msg.v !== PROTOCOL_VERSION) return { ok: false, reason: 'bad-version' };
  switch (msg.type) {
    case 'join':
      if (typeof msg.room !== 'string' || !ROOM_RE.test(msg.room)) return { ok: false, reason: 'bad-room' };
      if (typeof msg.name !== 'string' || !NAME_RE.test(msg.name)) return { ok: false, reason: 'bad-name' };
      return { ok: true, msg: { type: 'join', room: msg.room, name: msg.name } };
    case 'chat':
      if (typeof msg.text !== 'string' || msg.text.length < 1 || msg.text.length > MAX_CHAT) {
        return { ok: false, reason: 'bad-text' };
      }
      return { ok: true, msg: { type: 'chat', text: msg.text } };
    default:
      return { ok: false, reason: 'unknown-type' };
  }
}

/** Validate the body of POST /api/rooms. */
export function validateCreateRoom(body) {
  if (!isObj(body)) return { ok: false, reason: 'not-object' };
  if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 24) return { ok: false, reason: 'bad-name' };
  const asteroids = body.asteroids ?? 4;
  if (!Number.isInteger(asteroids) || asteroids < 1 || asteroids > 12) return { ok: false, reason: 'bad-asteroids' };
  return { ok: true, value: { name: body.name, asteroids } };
}

export const out = {
  welcome: (id, room) => JSON.stringify({ v: PROTOCOL_VERSION, type: 'welcome', id, room }),
  roster: (players) => JSON.stringify({ v: PROTOCOL_VERSION, type: 'roster', players }),
  chat: (from, text) => JSON.stringify({ v: PROTOCOL_VERSION, type: 'chat', from, text }),
  shutdown: () => JSON.stringify({ v: PROTOCOL_VERSION, type: 'shutdown' }),
};
