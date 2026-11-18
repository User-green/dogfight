// Latency / jitter / packet-loss injector. localhost has 0 ms latency, so netcode always "works" there;
// this makes the network bad on purpose, per connection, switchable live.
//
//   lag     round-trip delay added, ms. Each direction gets lag/2.
//   jitter  +-jitter/2 random extra delay per direction, ms (so the round trip varies by +-jitter)
//   drop    per-direction packet loss, percent
//
// Delivery order is preserved (like TCP): a delayed packet is never overtaken by a later one.
// Loss is simulated at the application level, as if an unreliable transport lost the packet.
import { NETSIM_LIMITS } from 'shared/protocol';

export const LIMITS = NETSIM_LIMITS;

export interface NetsimParams {
  lag: number;
  jitter: number;
  drop: number;
}
const KEYS = ['lag', 'jitter', 'drop'] as const;

/** `unknown` in, a clean `NetsimParams` or `null` out. Missing keys mean 0; out-of-range or non-numbers reject the whole thing. */
export function validateNetsim(p: unknown): NetsimParams | null {
  if (typeof p !== 'object' || p === null) return null;
  const result: NetsimParams = { lag: 0, jitter: 0, drop: 0 };
  for (const key of KEYS) {
    const v: unknown = Reflect.get(p, key) ?? 0;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > LIMITS[key]) return null;
    result[key] = v;
  }
  return result;
}

type Lane = 'in' | 'out';
type Timer = ReturnType<typeof setTimeout>;
interface LaneState {
  q: { due: number; fn: () => void }[];
  timer: Timer | null;
  last: number;
}

export interface NetSimOptions {
  rng?: () => number;
  now?: () => number;
}

export class NetSim {
  // One FIFO per lane with ONE timer armed for its head. Separate setTimeout()s per packet can fire out of
  // order when due times are within a millisecond of each other (timer lists are keyed by duration).
  #lanes: Record<Lane, LaneState> = { in: { q: [], timer: null, last: 0 }, out: { q: [], timer: null, last: 0 } };
  readonly rng: () => number;
  readonly now: () => number;
  readonly stats = { delivered: 0, dropped: 0 };
  lag = 0;
  jitter = 0;
  drop = 0;

  constructor(params: Partial<NetsimParams> = {}, { rng = Math.random, now = () => performance.now() }: NetSimOptions = {}) {
    this.rng = rng;
    this.now = now;
    this.set(params);
  }

  set({ lag = 0, jitter = 0, drop = 0 }: Partial<NetsimParams> = {}): void {
    this.lag = lag;
    this.jitter = jitter;
    this.drop = drop;
  }

  get enabled(): boolean {
    return this.lag > 0 || this.jitter > 0 || this.drop > 0;
  }

  /** Run `fn` after the simulated one-way delay on `lane` ('in' | 'out'), or never (dropped). */
  deliver(lane: Lane, fn: () => void): void {
    const L = this.#lanes[lane];
    if (!this.enabled && L.q.length === 0) {
      this.stats.delivered++;
      return fn();
    }
    if (this.rng() * 100 < this.drop) {
      this.stats.dropped++;
      return;
    }
    const t = this.now();
    const delay = Math.max(0, this.lag / 2 + (this.rng() * 2 - 1) * (this.jitter / 2));
    const due = Math.max(L.last, t + delay); // never earlier than the previous packet on this lane
    L.last = due;
    L.q.push({ due, fn });
    if (!L.timer) this.#arm(L);
  }

  #arm(L: LaneState): void {
    const head = L.q[0];
    if (!head) return;
    L.timer = setTimeout(() => {
      L.timer = null;
      const t = this.now();
      for (let next = L.q[0]; next !== undefined && next.due <= t + 0.5; next = L.q[0]) {
        this.stats.delivered++;
        L.q.shift();
        next.fn();
      }
      if (L.q.length) this.#arm(L);
    }, Math.max(0, head.due - this.now()));
  }

  /** Cancel everything still in flight (socket closed). */
  close(): void {
    for (const L of Object.values(this.#lanes)) {
      if (L.timer) clearTimeout(L.timer);
      L.timer = null;
      L.q.length = 0;
    }
  }
}
