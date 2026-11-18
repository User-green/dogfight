// Asset pipeline: every loader accepts an AbortSignal; transient failures are retried.

export class HttpError extends Error {
  constructor(url, status) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

const isAbort = (e) => e?.name === 'AbortError' || e?.name === 'TimeoutError';

/** fetch() does NOT reject on 404/500, so every request goes through here and checks `ok`. */
export async function fetchOk(url, { signal } = {}) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new HttpError(url, res.status);
  return res;
}

export async function fetchJson(url, opts) {
  const res = await fetchOk(url, opts);
  return res.json(); // second async step: reading the body. Throws SyntaxError on corrupt JSON.
}

/** Sleep that stops immediately when the signal aborts. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(signal.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retry with exponential backoff and full jitter.
 * Never retries: aborts, 4xx (the request itself is wrong), or corrupt JSON.
 * `fn` receives the signal so it can cancel its own work.
 */
export async function withRetry(fn, { attempts = 3, baseMs = 200, signal, sleepFn = sleep } = {}) {
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
export function loadImage(src, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const img = new Image();
    const onAbort = () => {
      img.src = ''; // stop the download
      reject(signal.reason);
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
export async function loadAudio(audioCtx, url, { signal } = {}) {
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
export async function loadAll(manifest, { onProgress = () => {}, signal, audioCtx, loaders = {}, retry = {} } = {}) {
  const load = {
    json: (url, s) => fetchJson(url, { signal: s }),
    image: (url, s) => loadImage(url, { signal: s }),
    audio: (url, s) => loadAudio(audioCtx, url, { signal: s }),
    ...loaders,
  };

  const items = [
    ['sprites', 'image', manifest.sprites],
    ['arena', 'json', manifest.arena],
    ...Object.entries(manifest.sounds ?? {}).map(([name, spec]) => [`sound:${name}`, 'audio', spec]),
  ].filter(([, , spec]) => spec);

  // Internal controller: lets one required failure cancel the other in-flight loads,
  // and still honours the caller's own signal.
  const inner = new AbortController();
  const onOuterAbort = () => inner.abort(signal.reason);
  if (signal?.aborted) inner.abort(signal.reason);
  else signal?.addEventListener('abort', onOuterAbort, { once: true });

  const failures = [];
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
