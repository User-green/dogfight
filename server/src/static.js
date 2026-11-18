import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/** Serve a file from `root`. Returns false if nothing matched (caller sends 404). */
export async function serveStatic(root, urlPath, res) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400).end('bad path');
    return true;
  }
  if (rel.includes('\0')) {
    res.writeHead(400).end('bad path');
    return true;
  }
  // Path traversal guard: resolve, then require the result to stay inside root.
  const full = normalize(join(root, rel === '/' ? 'index.html' : rel));
  if (full !== root && !full.startsWith(root + sep)) {
    res.writeHead(403).end('forbidden');
    return true;
  }
  let info;
  try {
    info = await stat(full);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  const immutable = full.includes(`${sep}assets${sep}`) && /-[\w-]{8,}\./.test(full); // hashed Vite output
  res.writeHead(200, {
    'content-type': MIME[extname(full)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  await pipeline(createReadStream(full), res).catch(() => {});
  return true;
}
