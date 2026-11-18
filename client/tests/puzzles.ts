// Five ordering puzzles (puzzle 5 needs a browser: see tests/puzzle-raf.py)
export {}; // makes this file a module (top-level await)
const out: string[] = [];
const log = (x: string): void => void out.push(x);
const run = async (name: string, fn: () => void | Promise<void>): Promise<void> => { out.length = 0; await fn(); await new Promise((r) => setTimeout(r, 20)); console.log(name, '->', out.join(' ')); };

await run('P1', () => {
  setTimeout(() => log('timeout'), 0);
  Promise.resolve().then(() => log('then'));
  log('sync');
});
await run('P2', () => {
  (async () => { log('a1'); await null; log('a2'); })();
  log('main');
});
await run('P3 (setTimeout inside then)', () => {
  Promise.resolve().then(() => { log('then1'); setTimeout(() => log('timeout-in-then'), 0); }).then(() => log('then2'));
  setTimeout(() => log('timeout-outer'), 0);
});
await run('P4 (await of a promise vs then chain)', () => {
  const p = Promise.resolve();
  (async () => { await p; log('await-1'); await p; log('await-2'); })();
  p.then(() => log('then-A')).then(() => log('then-B')).then(() => log('then-C'));
});
await run('P6 (reflection q3)', () => {
  setTimeout(() => log('1'));
  Promise.resolve().then(() => log('2')).then(() => log('3'));
  (async () => { log('4'); await 0; log('5'); })();
  log('6');
});
