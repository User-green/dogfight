// Asset pipeline: every loader accepts an AbortSignal; transient failures are retried.
import type { AssetSpec, LoadManifest } from './manifest.ts';

export interface LoadOptions {
  signal?: AbortSignal | undefined;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(url: string, status: number) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

// `catch (e)` gives `unknown`: look at it with a type guard, not a cast.
const isAbort = (e: unknown): boolean => e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');

/** fetch() does NOT reject on 404/500, so every request goes through here and checks `ok`. */
export async function fetchOk(url: string, { signal }: LoadOptions = {}): Promise<Response> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new HttpError(url, res.status);
  return res;
}

/** Returns `unknown` on purpose: JSON from the network is not typed until something validates it (see manifest.ts). */
export async function fetchJson(url: string, opts?: LoadOptions): Promise<unknown> {
  const res = await fetchOk(url, opts);
  const body: unknown = await res.json(); // second async step: reading the body. Throws SyntaxError on corrupt JSON.
  return body;
}

/** Sleep that stops immediately when the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retry with exponential backoff and full jitter.
 * Never retries: aborts, 4xx (the request itself is wrong), or corrupt JSON.
 * `fn` receives the signal so it can cancel its own work.
 */
export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  signal?: AbortSignal | undefined;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export async function withRetry<T>(fn: (signal?: AbortSignal) => Promise<T>, { attempts = 3, baseMs = 200, signal, sleepFn = sleep }: RetryOptions = {}): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn(signal);
    } catch (err) {
      const is4xx = err instanceof HttpError && err.status >= 400 && err.status < 500;
      const corrupt = err instanceof SyntaxError; // bad JSON is deterministic: retrying cannot fix it
      if (isAbort(err) || is4xx || corrupt || i >= attempts - 1) throw err;
      const delay = Math.random() * baseMs * 2 ** i; // full jitter: uniform in [0, base * 2^i)
      await sleepFn(delay, signal);
    }
  }
}

/** Wrap an old callback API (onload/onerror) in a promise. */
export function loadImage(src: string, { signal }: LoadOptions = {}): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const img = new Image();
    const onAbort = () => {
      img.src = ''; // stop the download
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    img.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(img);
    };
    img.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`failed to load image ${src}`));
    };
    img.src = src;
  });
}

/** fetch -> arrayBuffer -> decodeAudioData: three async steps. */
export async function loadAudio(audioCtx: BaseAudioContext, url: string, { signal }: LoadOptions = {}): Promise<AudioBuffer> {
  const res = await fetchOk(url, { signal });
  const bytes = await res.arrayBuffer();
  return audioCtx.decodeAudioData(bytes);
}

/**
 * Load everything in the manifest CONCURRENTLY with per-item progress.
 *
 * Item policy: required items reject the whole load (and cancel the siblings);
 * optional items that fail resolve to null and are listed in `failures`,
 * so the game can fall back (vector drawing, silence).
 *
 * `loaders` is injectable so this logic can be tested in Node without Image/AudioContext.
 */
export type LoaderKind = 'json' | 'image' | 'audio';
export type Loader = (url: string, signal?: AbortSignal) => Promise<unknown>;

export interface LoadAllOptions {
  onProgress?: (fraction: number, total: number, name?: string) => void;
  signal?: AbortSignal;
  audioCtx?: BaseAudioContext;
  loaders?: Partial<Record<LoaderKind, Loader>>;
  retry?: Omit<RetryOptions, 'signal'>;
}

export interface LoadFailure {
  name: string;
  url: string;
  error: unknown;
}

/** Loaded values are `unknown`: the caller knows which key is which and narrows (instanceof / zod) at the boundary. */
export interface LoadResult {
  assets: Record<string, unknown>;
  failures: LoadFailure[];
}

export async function loadAll(manifest: LoadManifest, { onProgress = () => {}, signal, audioCtx, loaders = {}, retry = {} }: LoadAllOptions = {}): Promise<LoadResult> {
  const load: Record<LoaderKind, Loader> = {
    json: (url, s) => fetchJson(url, { signal: s }),
    image: (url, s) => loadImage(url, { signal: s }),
    audio: (url, s) => {
      if (!audioCtx) throw new Error('loadAll: an audioCtx is required to load audio');
      return loadAudio(audioCtx, url, { signal: s });
    },
    ...loaders,
  };

  const items: [name: string, type: LoaderKind, spec: AssetSpec][] = [];
  if (manifest.sprites) items.push(['sprites', 'image', manifest.sprites]);
  if (manifest.arena) items.push(['arena', 'json', manifest.arena]);
  for (const [name, spec] of Object.entries(manifest.sounds ?? {})) items.push([`sound:${name}`, 'audio', spec]);

  // Internal controller: lets one required failure cancel the other in-flight loads,
  // and still honours the caller's own signal.
  const inner = new AbortController();
  const onOuterAbort = () => inner.abort(signal?.reason);
  if (signal?.aborted) inner.abort(signal.reason);
  else signal?.addEventListener('abort', onOuterAbort, { once: true });

  const failures: LoadFailure[] = [];
  let done = 0;
  const total = items.length;
  onProgress(0, total);

  const tasks = items.map(([name, type, spec]) =>
    withRetry((s) => load[type](spec.url, s), { signal: inner.signal, ...retry })
      .catch((err) => {
        if (spec.required) throw err; // required: let Promise.all reject
        if (isAbort(err)) throw err; // an abort is never "gracefully ignored"
        failures.push({ name, url: spec.url, error: err });
        return null;
      })
      .then((value) => {
        done++;
        onProgress(done / total, total, name);
        return value;
      }),
  );

  try {
    const values = await Promise.all(tasks);
    return { assets: Object.fromEntries(items.map(([name], i) => [name, values[i]])), failures };
  } catch (err) {
    inner.abort(err); // Promise.all does not cancel siblings; we do it explicitly
    throw err;
  } finally {
    signal?.removeEventListener('abort', onOuterAbort);
  }
}
