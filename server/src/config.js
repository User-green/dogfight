// All configuration comes from the environment, validated and defaulted in ONE place.
import { resolve } from 'node:path';

function int(env, name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`config: ${name}=${raw} must be an integer in [${min}, ${max}]`);
  }
  return n;
}

export function loadConfig(env = process.env, overrides = {}) {
  const cfg = {
    port: int(env, 'PORT', 3000, { max: 65535 }),
    host: env.HOST || '127.0.0.1',
    logDir: resolve(env.LOG_DIR || './logs'),
    staticDir: resolve(env.STATIC_DIR || '../client/dist'),
    debugRoutes: env.ENABLE_DEBUG_ROUTES === '1',
    maxRooms: int(env, 'MAX_ROOMS', 20, { min: 1 }),
    maxPlayersPerRoom: int(env, 'MAX_PLAYERS_PER_ROOM', 8, { min: 1 }),
    maxPayload: int(env, 'MAX_PAYLOAD', 1024, { min: 16 }), // bytes per WebSocket message
    msgPerSecond: int(env, 'MSG_PER_SECOND', 20, { min: 1 }), // token-bucket refill rate
    msgBurst: int(env, 'MSG_BURST', 40, { min: 1 }), // token-bucket capacity
    joinTimeoutMs: int(env, 'JOIN_TIMEOUT_MS', 5000, { min: 10 }),
    heartbeatMs: int(env, 'HEARTBEAT_MS', 15000, { min: 10 }),
    slowClientBytes: int(env, 'SLOW_CLIENT_BYTES', 64 * 1024, { min: 1 }),
    maxBodyBytes: int(env, 'MAX_BODY_BYTES', 4096, { min: 16 }),
    ...overrides,
  };
  return Object.freeze(cfg);
}
