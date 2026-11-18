import { loadConfig } from './config.ts';
import { createGameServer } from './server.ts';

const config = loadConfig();
const server = createGameServer(config);
const addr = await server.listen();
console.log(`dogfight server on http://${addr.address}:${addr.port} (static: ${config.staticDir})`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  const force = setTimeout(() => {
    console.error('shutdown took > 10 s, forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();
  await server.stop();
  console.log('clean exit');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
