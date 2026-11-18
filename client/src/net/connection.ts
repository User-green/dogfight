// WebSocket wrapper: dispatch by message `type`, send queue while connecting, reconnect with backoff.
import { parseServerMessage } from 'shared/protocol';
import type { ClientMessage, ServerMessage } from 'shared/protocol';
import { TypedTarget } from '../typed-target.ts';

const FATAL = new Set([4000, 4003, 4004]); // protocol error / room full / no such room: retrying cannot help

export type Status = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
export interface StatusDetail {
  status: Status;
  attempt?: number;
  delay?: number;
  code?: number;
  reason?: string;
}

/** One entry per server message type (payload = the whole parsed message), plus the two transport-level events. */
export type ConnectionEvents = { [T in ServerMessage['type']]: Extract<ServerMessage, { type: T }> } & {
  status: StatusDetail;
  binary: ArrayBuffer;
};

/** The slice of the browser WebSocket this class uses. Tests pass a fake; structural typing means no `as`. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What callers send: a client message without the protocol version (added here, in one place). */
export type Outgoing = DistributiveOmit<ClientMessage, 'v'>;

export interface ConnectionOptions {
  url: string;
  baseMs?: number;
  maxMs?: number;
  WebSocketImpl?: WebSocketCtor;
}

/** The DOM WebSocket is wider than the slice of it we use (richer event types), so it is not assignable by structure alone: this is the one place we assert it. */
const browserWebSocket = globalThis.WebSocket as unknown as WebSocketCtor;

export class Connection extends TypedTarget<ConnectionEvents> {
  #ws: WebSocketLike | null = null;
  #queue: string[] = [];
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closedByUser = false;
  #hello: ClientMessage | null = null;

  readonly url: string;
  readonly baseMs: number;
  readonly maxMs: number;
  readonly WebSocketImpl: WebSocketCtor;
  status: Status = 'idle';
  lastBytes = 0; // size of the frame being dispatched (the netgraph counts bytes in)

  constructor({ url, baseMs = 250, maxMs = 5000, WebSocketImpl = browserWebSocket }: ConnectionOptions) {
    super();
    this.url = url;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.WebSocketImpl = WebSocketImpl;
  }

  #setStatus(status: Status, detail?: Omit<StatusDetail, 'status'>): void {
    this.status = status;
    this.emit('status', { status, ...detail });
  }

  /** `hello` is re-sent on EVERY (re)connect, before the queued messages. */
  connect(hello?: ClientMessage): void {
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
        this.emit('binary', e.data);
        return;
      }
      this.lastBytes = e.data.length;
      let json: unknown;
      try {
        json = JSON.parse(e.data);
      } catch {
        return; // ignore garbage from the server
      }
      // One schema decides what a server message is. Before this, a snapshot with a broken `ents` got through.
      const parsed = parseServerMessage(json);
      if (!parsed.ok) return;
      this.#dispatch(parsed.value);
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

  /** Dispatch by type. The switch is what lets TypeScript pair each type with its own payload (no cast needed). */
  #dispatch(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome': return this.emit('welcome', msg);
      case 'pong': return this.emit('pong', msg);
      case 'error': return this.emit('error', msg);
      case 'roster': return this.emit('roster', msg);
      case 'chat': return this.emit('chat', msg);
      case 'shutdown': return this.emit('shutdown', msg);
      case 'snapshot': return this.emit('snapshot', msg);
    }
  }

  #scheduleReconnect(code: number): void {
    // exponential backoff with full jitter, capped
    const delay = Math.random() * Math.min(this.maxMs, this.baseMs * 2 ** this.#attempt);
    this.#attempt++;
    this.#setStatus('reconnecting', { attempt: this.#attempt, delay, code });
    this.#timer = setTimeout(() => this.connect(), delay);
  }

  send(obj: Outgoing): void {
    const data = JSON.stringify({ v: 1, ...obj });
    if (this.#ws?.readyState === 1) this.#ws.send(data);
    else this.#queue.push(data);
  }

  /** Send a pre-encoded payload (input packet: string or ArrayBuffer). Dropped, not queued, while disconnected: stale inputs are useless. */
  sendRaw(payload: string | ArrayBuffer): void {
    if (this.#ws?.readyState === 1) this.#ws.send(payload);
  }

  close(): void {
    this.#closedByUser = true;
    clearTimeout(this.#timer);
    this.#ws?.close();
    if (!this.#ws) this.#setStatus('closed', { code: 1000 });
  }
}

/** `extra` is a query-string source, e.g. {lag:100,jitter:30,drop:2}: the server's NetSim (ENABLE_NETSIM=1) reads it. */
export function defaultWsUrl(extra: Record<string, string | null | undefined> = {}): string {
  const entries = Object.entries(extra).filter((e): e is [string, string] => e[1] !== null && e[1] !== undefined);
  const q = new URLSearchParams(entries).toString();
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${q ? `?${q}` : ''}`;
}
