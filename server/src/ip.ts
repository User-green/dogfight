import type { IncomingMessage } from 'node:http';

/** Extract the client IP, honoring `X-Forwarded-For` only when `trustProxy` is enabled. */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const raw = req.headers['x-forwarded-for'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    const first = header?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}
