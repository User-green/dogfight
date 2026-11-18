// A thin typed layer over EventTarget. The runtime is still plain DOM events (CustomEvent, addEventListener),
// so everything that listens the old way keeps working; the map only adds compile-time checking of
// "which event name carries which payload".

/** Event name -> payload type. `void` means "no payload". */
export type EventMap = Record<string, unknown>;

export class TypedTarget<M extends EventMap> extends EventTarget {
  /** Subscribe; the callback gets the payload directly, not the CustomEvent wrapper. Returns an unsubscribe function. */
  on<K extends keyof M & string>(type: K, fn: (detail: M[K]) => void, options?: { once?: boolean; signal?: AbortSignal }): () => void {
    const listener = (e: Event) => fn((e as CustomEvent<M[K]>).detail);
    this.addEventListener(type, listener, options);
    return () => this.removeEventListener(type, listener);
  }

  emit<K extends keyof M & string>(type: K, detail: M[K]): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
