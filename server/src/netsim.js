// Latency / jitter / packet-loss injector. localhost has 0 ms latency, so netcode always "works" there;
// this makes the network bad on purpose, per connection, switchable live.
//
//   lag     round-trip delay added, ms. Each direction gets lag/2.
//   jitter  +-jitter/2 random extra delay per direction, ms (so the round trip varies by +-jitter)
//   drop    per-direction packet loss, percent
//
// Delivery order is preserved (like TCP): a delayed packet is never overtaken by a later one.
// Loss is simulated at the application level, as if an unreliable transport lost the packet.
export const LIMITS = Object.freeze({ lag: 2000, jitter: 1000, drop: 100 });

export function validateNetsim(p) {
  if (typeof p !== 'object' || p === null) return null;
  const out = {};
  for (const key of ['lag', 'jitter', 'drop']) {
    const v = p[key] ?? 0;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > LIMITS[key]) return null;
    out[key] = v;
  }
  return out;
}

export class NetSim {
  // One FIFO per lane with ONE timer armed for its head. Separate setTimeout()s per packet can fire out of
  // order when due times are within a millisecond of each other (timer lists are keyed by duration).
  #lanes = { in: { q: [], timer: null, last: 0 }, out: { q: [], timer: null, last: 0 } };

  constructor(params = {}, { rng = Math.random, now = () => performance.now() } = {}) {
    this.rng = rng;
    this.now = now;
    this.stats = { delivered: 0, dropped: 0 };
    this.set(params);
  }

  set({ lag = 0, jitter = 0, drop = 0 } = {}) {
    this.lag = lag;
    this.jitter = jitter;
    this.drop = drop;
  }

  get enabled() {
    return this.lag > 0 || this.jitter > 0 || this.drop > 0;
  }

  /** Run `fn` after the simulated one-way delay on `lane` ('in' | 'out'), or never (dropped). */
  deliver(lane, fn) {
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

  #arm(L) {
    L.timer = setTimeout(() => {
      L.timer = null;
      const t = this.now();
      while (L.q.length && L.q[0].due <= t + 0.5) {
        this.stats.delivered++;
        L.q.shift().fn();
      }
      if (L.q.length) this.#arm(L);
    }, Math.max(0, L.q[0].due - this.now()));
  }

  /** Cancel everything still in flight (socket closed). */
  close() {
    for (const L of Object.values(this.#lanes)) {
      clearTimeout(L.timer);
      L.timer = null;
      L.q.length = 0;
    }
  }
}
