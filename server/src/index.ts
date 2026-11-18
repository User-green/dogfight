import { loadConfig } from './config.ts';
import { log } from './logger.ts';
import { createGameServer } from './server.ts';

const config = loadConfig();
log.level = config.logLevel;
const server = createGameServer(config);
const addr = await server.listen();
log.info({ event: 'server.listening', host: addr.address, port: addr.port, version: config.version, staticDir: config.staticDir });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info({ event: 'server.shutdown', signal });
  const force = setTimeout(() => {
    log.error({ event: 'server.shutdown.forced' }, 'shutdown took > 10 s, forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();
  server.beginShutdown();
  await server.stop();
  log.info({ event: 'server.exit' });
  // pino writes synchronously to stdout in this configuration, so nothing is lost by exiting here
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// An unknown failure means state we do not understand: log it, exit non-zero, let the supervisor restart a clean process.
function crash(event: string, err: unknown): never {
  log.fatal({ event, err }, 'unrecoverable');
  process.exit(1);
}
process.on('uncaughtException', (err) => crash('process.uncaughtException', err));
process.on('unhandledRejection', (err) => crash('process.unhandledRejection', err));
