import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Async generator: yields parsed events from an NDJSON file without loading it into memory. */
export async function* replay(path) {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line) yield JSON.parse(line);
    }
  } finally {
    stream.destroy(); // if the consumer breaks early, release the file descriptor
  }
}
