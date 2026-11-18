// Run:  node crash-demo.ts error | error-fixed | rejection | rejection-fixed
import { EventEmitter } from 'node:events';
const mode = process.argv[2];
const room = new EventEmitter();
if (mode === 'error') {
  room.emit('error', new Error('socket exploded')); // no listener -> throws -> process dies
} else if (mode === 'error-fixed') {
  room.on('error', (e) => console.log('handled:', e.message));
  room.emit('error', new Error('socket exploded'));
  console.log('server still running');
} else if (mode === 'rejection') {
  const handler = async () => { throw new Error('db write failed'); };
  handler(); // nobody awaits it, nobody catches it -> unhandledRejection -> exit code 1
  setTimeout(() => console.log('never printed'), 100);
} else if (mode === 'rejection-fixed') {
  const handler = async () => { throw new Error('db write failed'); };
  handler().catch((e) => console.log('handled:', e.message));
  setTimeout(() => console.log('server still running'), 100);
}
