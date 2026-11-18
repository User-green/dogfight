import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { on } from 'node:events';
import { join } from 'node:path';

/** Object-mode in, text out: one JSON object per line (NDJSON). */
export class NdjsonTransform extends Transform {
  constructor() {
    super({ writableObjectMode: true, readableObjectMode: false });
  }
  _transform(event, _enc, cb) {
    cb(null, JSON.stringify(event) + '\n');
  }
}

/** Turn an events.on() iterator into an async iterable of events that ends cleanly on abort. */
async function* unwrap(iterator) {
  try {
    for await (const [event] of iterator) yield event;
  } catch (err) {
    if (err.name !== 'AbortError') throw err; // abort = normal end of the match
  }
}

/**
 * Start logging a room: events.on -> Readable.from -> Transform -> file, via pipeline().
 * pipeline handles backpressure, error propagation and closing every stream.
 */
export async function startMatchLog(room, logDir) {
  // Subscribe SYNCHRONOUSLY, before the first await: events emitted in this same tick
  // (e.g. the very 'join' that triggered us) would otherwise be lost.
  const controller = new AbortController();
  const iterator = on(room, 'event', { signal: controller.signal });
  await mkdir(logDir, { recursive: true });
  const id = `${room.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const path = join(logDir, `${id}.ndjson`);
  const done = pipeline(
    Readable.from(unwrap(iterator)),
    new NdjsonTransform(),
    createWriteStream(path),
  );
  return {
    id,
    path,
    done,
    /** Ends the log; resolves after the file is flushed and closed. */
    stop() {
      controller.abort();
      return done;
    },
  };
}
