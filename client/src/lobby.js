import { fetchJson } from './assets/loader.js';

/** Data layer only: no DOM here. The view (ui/lobbyView.js) subscribes to events. */
export class Lobby extends EventTarget {
  #controller = null; // aborts the in-flight request
  #timer = null;
  rooms = [];

  constructor({ url = '/api/rooms', timeoutMs = 3000 } = {}) {
    super();
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  async refresh() {
    this.#controller?.abort(); // a newer refresh replaces an older one
    const controller = (this.#controller = new AbortController());
    // Combine: aborted by us (leaving the lobby) OR by the timeout.
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      const data = await fetchJson(this.url, { signal });
      this.rooms = data.rooms;
      this.dispatchEvent(new CustomEvent('roomsChanged', { detail: this.rooms }));
    } catch (err) {
      if (controller.signal.aborted) return; // we cancelled it ourselves: not an error
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
    }
  }

  startPolling(intervalMs = 5000) {
    this.stopPolling();
    this.refresh();
    this.#timer = setInterval(() => this.refresh(), intervalMs);
  }

  /** Leaving the lobby: stop the timer AND cancel the request in flight. */
  stopPolling() {
    clearInterval(this.#timer);
    this.#timer = null;
    this.#controller?.abort();
    this.#controller = null;
  }

  join(roomId, playerName) {
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room) throw new Error(`unknown room ${roomId}`);
    this.stopPolling();
    this.dispatchEvent(new CustomEvent('joined', { detail: { room, playerName } }));
  }
}
