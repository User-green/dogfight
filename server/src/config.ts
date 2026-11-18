// All configuration comes from the environment, validated and defaulted in ONE place (a zod schema).
import { resolve } from 'node:path';
import { z } from 'zod';

const MAX = Number.MAX_SAFE_INTEGER;

/** An integer env var: unset or empty means the default; anything else must parse to an integer in range. */
const intVar = (def: number, { min = 0, max = MAX }: { min?: number; max?: number } = {}) =>
  z.preprocess((v) => (v === undefined || v === '' ? def : Number(v)), z.int().min(min).max(max));
const strVar = (def: string) => z.preprocess((v) => (v === undefined || v === '' ? def : v), z.string());
const flagVar = z.preprocess((v) => v === '1', z.boolean());

/** Config key -> the environment variable it is read from (used for readable error messages). */
const ENV_NAMES = {
  port: 'PORT',
  host: 'HOST',
  logDir: 'LOG_DIR',
  staticDir: 'STATIC_DIR',
  debugRoutes: 'ENABLE_DEBUG_ROUTES',
  maxRooms: 'MAX_ROOMS',
  maxPlayersPerRoom: 'MAX_PLAYERS_PER_ROOM',
  maxPayload: 'MAX_PAYLOAD',
  msgPerSecond: 'MSG_PER_SECOND',
  msgBurst: 'MSG_BURST',
  joinTimeoutMs: 'JOIN_TIMEOUT_MS',
  heartbeatMs: 'HEARTBEAT_MS',
  slowClientBytes: 'SLOW_CLIENT_BYTES',
  maxBodyBytes: 'MAX_BODY_BYTES',
  inputPerSecond: 'INPUT_PER_SECOND',
  inputBurst: 'INPUT_BURST',
  allowNetsim: 'ENABLE_NETSIM',
  maxBots: 'MAX_BOTS',
} as const;

const ConfigSchema = z.object({
  port: intVar(3000, { max: 65535 }),
  host: strVar('127.0.0.1'),
  logDir: strVar('./logs').transform((p) => resolve(p)),
  staticDir: strVar('../client/dist').transform((p) => resolve(p)),
  debugRoutes: flagVar,
  maxRooms: intVar(20, { min: 1 }),
  maxPlayersPerRoom: intVar(8, { min: 1 }),
  maxPayload: intVar(1024, { min: 16 }), // bytes per WebSocket message
  msgPerSecond: intVar(20, { min: 1 }), // token-bucket refill rate
  msgBurst: intVar(40, { min: 1 }), // token-bucket capacity
  joinTimeoutMs: intVar(5000, { min: 10 }),
  heartbeatMs: intVar(15000, { min: 10 }),
  slowClientBytes: intVar(64 * 1024, { min: 1 }),
  maxBodyBytes: intVar(4096, { min: 16 }),
  inputPerSecond: intVar(45, { min: 1 }), // inputs arrive at 30/s; headroom for bursts
  inputBurst: intVar(90, { min: 1 }),
  allowNetsim: flagVar, // latency/loss injector: dev and tests only
  maxBots: intVar(16), // per room; the bots endpoint is unauthenticated, so this is its only brake (0 disables it)
});

export type ServerConfig = Readonly<z.output<typeof ConfigSchema>>;

const isEnvKey = (key: unknown): key is keyof typeof ENV_NAMES => typeof key === 'string' && key in ENV_NAMES;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<z.output<typeof ConfigSchema>> = {}): ServerConfig {
  const raw = Object.fromEntries(Object.entries(ENV_NAMES).map(([key, name]) => [key, env[name]]));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue?.path[0];
    const name = isEnvKey(key) ? ENV_NAMES[key] : String(key);
    throw new Error(`config: ${name}=${String(typeof key === 'string' ? env[name] : '')} is invalid (${issue?.message ?? 'unknown'})`);
  }
  return Object.freeze({ ...parsed.data, ...overrides });
}
