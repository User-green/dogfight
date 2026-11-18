import { z } from 'zod';
import { RoomInfoSchema } from 'shared/protocol';
import type { RoomInfo } from 'shared/protocol';
import { fetchJson } from './assets/loader.ts';
import { TypedTarget } from './typed-target.ts';

const RoomsResponseSchema = z.object({ rooms: z.array(RoomInfoSchema) });

export type LobbyEvents = {
  roomsChanged: RoomInfo[];
  error: Error;
  joined: { room: RoomInfo; playerName: string };
};

/** Data layer only: no DOM here. The view (ui/lobbyView.ts) subscribes to events. */
export class Lobby extends TypedTarget<LobbyEvents> {
  #controller: AbortController | null = null; // aborts the in-flight request
  #timer: ReturnType<typeof setInterval> | undefined;
  rooms: RoomInfo[] = [];
  readonly url: string;
  readonly timeoutMs: number;

  constructor({ url = '/api/rooms', timeoutMs = 3000 }: { url?: string; timeoutMs?: number } = {}) {
    super();
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  async refresh(): Promise<void> {
    this.#controller?.abort(); // a newer refresh replaces an older one
    const controller = (this.#controller = new AbortController());
    // Combine: aborted by us (leaving the lobby) OR by the timeout.
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      this.rooms = RoomsResponseSchema.parse(await fetchJson(this.url, { signal })).rooms; // throws a ZodError if the API drifts
      this.emit('roomsChanged', this.rooms);
    } catch (err) {
      if (controller.signal.aborted) return; // we cancelled it ourselves: not an error
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  startPolling(intervalMs = 5000): void {
    this.stopPolling();
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), intervalMs);
  }

  /** Leaving the lobby: stop the timer AND cancel the request in flight. */
  stopPolling(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#controller?.abort();
    this.#controller = null;
  }

  join(roomId: string, playerName: string): void {
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room) throw new Error(`unknown room ${roomId}`);
    this.stopPolling();
    this.emit('joined', { room, playerName });
  }
}
