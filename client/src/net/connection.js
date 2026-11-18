// WebSocket wrapper: dispatch by message `type`, send queue while connecting, reconnect with backoff.
const FATAL = new Set([4000, 4003, 4004]); // protocol error / room full / no such room: retrying cannot help

export class Connection extends EventTarget {
  #ws = null;
  #queue = [];
  #attempt = 0;
  #timer = null;
  #closedByUser = false;
  #hello = null;

  constructor({ url, baseMs = 250, maxMs = 5000, WebSocketImpl = globalThis.WebSocket } = {}) {
    super();
    this.url = url;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.WebSocketImpl = WebSocketImpl;
    this.status = 'idle'; // idle | connecting | open | reconnecting | closed
    this.lastBytes = 0; // size of the frame being dispatched (the netgraph counts bytes in)
  }

  #setStatus(status, detail) {
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, ...detail } }));
  }

  /** `hello` is re-sent on EVERY (re)connect, before the queued messages. */
  connect(hello) {
    if (hello) this.#hello = hello;
    this.#closedByUser = false;
    this.#setStatus(this.#attempt === 0 ? 'connecting' : 'reconnecting', { attempt: this.#attempt });
    const ws = (this.#ws = new this.WebSocketImpl(this.url));
    ws.binaryType = 'arraybuffer'; // binary snapshots arrive as ArrayBuffer, not Blob (Blob would need an async read)
    ws.onopen = () => {
      this.#attempt = 0;
      this.#setStatus('open');
      if (this.#hello) ws.send(JSON.stringify(this.#hello));
      for (const m of this.#queue.splice(0)) ws.send(m); // flush what was queued while connecting
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        this.lastBytes = e.data.byteLength;
        this.dispatchEvent(new CustomEvent('binary', { detail: e.data }));
        return;
      }
      this.lastBytes = e.data.length;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return; // ignore garbage from the server
      }
      if (typeof msg?.type !== 'string') return;
      this.dispatchEvent(new CustomEvent(msg.type, { detail: msg })); // dispatch by type
    };
    ws.onerror = () => {}; // 'close' always follows; handle recovery there
    ws.onclose = (e) => {
      this.#ws = null;
      if (this.#closedByUser || FATAL.has(e.code)) {
        return this.#setStatus('closed', { code: e.code, reason: e.reason });
      }
      this.#scheduleReconnect(e.code);
    };
  }

  #scheduleReconnect(code) {
    // exponential backoff with full jitter, capped
    const delay = Math.random() * Math.min(this.maxMs, this.baseMs * 2 ** this.#attempt);
    this.#attempt++;
    this.#setStatus('reconnecting', { attempt: this.#attempt, delay, code });
    this.#timer = setTimeout(() => this.connect(), delay);
  }

  send(obj) {
    const data = JSON.stringify({ v: 1, ...obj });
    if (this.#ws?.readyState === 1) this.#ws.send(data);
    else this.#queue.push(data);
  }

  /** Send a pre-encoded payload (input packet: string or ArrayBuffer). Dropped, not queued, while disconnected: stale inputs are useless. */
  sendRaw(payload) {
    if (this.#ws?.readyState === 1) this.#ws.send(payload);
  }

  close() {
    this.#closedByUser = true;
    clearTimeout(this.#timer);
    this.#ws?.close();
    if (!this.#ws) this.#setStatus('closed', { code: 1000 });
  }
}

/** `extra` is a query-string source, e.g. {lag:100,jitter:30,drop:2}: the server's NetSim (ENABLE_NETSIM=1) reads it. */
export function defaultWsUrl(extra = {}) {
  const q = new URLSearchParams(Object.entries(extra).filter(([, v]) => v !== null && v !== undefined)).toString();
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${q ? `?${q}` : ''}`;
}
