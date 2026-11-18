/** Token bucket: `capacity` tokens, refilled at `perSecond`. Clock is injectable for tests. */
export class TokenBucket {
  #tokens;
  #last;
  constructor({ capacity, perSecond, now = () => performance.now() }) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.now = now;
    this.#tokens = capacity;
    this.#last = now();
  }
  /** @returns {boolean} true if the message is allowed */
  take(cost = 1) {
    const t = this.now();
    this.#tokens = Math.min(this.capacity, this.#tokens + ((t - this.#last) / 1000) * this.perSecond);
    this.#last = t;
    if (this.#tokens < cost) return false;
    this.#tokens -= cost;
    return true;
  }
}
