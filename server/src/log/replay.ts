import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Async generator: yields parsed events from an NDJSON file without loading it into memory. Each event is `unknown`: the caller must check it. */
export async function* replay(path: string): AsyncGenerator<unknown, void, undefined> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line) {
        const event: unknown = JSON.parse(line);
        yield event;
      }
    }
  } finally {
    stream.destroy(); // if the consumer breaks early, release the file descriptor
  }
}
