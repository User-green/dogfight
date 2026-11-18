import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { validate, validateCreateRoom } from '../src/protocol.ts';
import type { SocketLike } from '../src/rooms.ts';
import { TokenBucket } from '../src/rate-limit.ts';
import { RoomManager, Room } from '../src/rooms.ts';
import { NdjsonTransform } from '../src/log/matchlog.ts';
import { loadConfig } from '../src/config.ts';

const join = (o: object = {}): string => JSON.stringify({ v: 1, type: 'join', room: 'alpha', name: 'Pilot', ...o });

/** The smallest thing that satisfies SocketLike: structural typing means no `ws` needed in a unit test. */
function fakeSocket(buffered = 0): SocketLike & { sent: (string | ArrayBuffer)[]; closed: number | null } {
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: buffered,
    sent: [],
    closed: null,
    send(p) {
      this.sent.push(p);
    },
    close(code) {
      this.closed = code ?? null;
    },
  };
}

test('protocol: valid join / chat', () => {
  assert.deepEqual(validate(join()), { ok: true, value: { v: 1, type: 'join', room: 'alpha', name: 'Pilot', codec: 'json' } });
  assert.equal(validate(JSON.stringify({ v: 1, type: 'chat', text: 'hi' })).ok, true);
});

test('protocol: rejects every kind of bad input', () => {
  const bad: [string, string][] = [
    ['not json', 'not-json'],
    ['[]', 'not-object'],
    ['"x"', 'not-object'],
    [JSON.stringify({ type: 'chat', text: 'x' }), 'bad-version'],
    [JSON.stringify({ v: 2, type: 'chat', text: 'x' }), 'bad-version'],
    [JSON.stringify({ v: 1, type: 'fly' }), 'unknown-type'],
    [join({ room: '../etc' }), 'bad-room'],
    [join({ name: '' }), 'bad-name'],
    [join({ name: 'x'.repeat(17) }), 'bad-name'],
    [join({ name: 5 }), 'bad-name'],
    [JSON.stringify({ v: 1, type: 'chat', text: '' }), 'bad-text'],
    [JSON.stringify({ v: 1, type: 'chat', text: 'x'.repeat(201) }), 'bad-text'],
    [JSON.stringify({ v: 1, type: 'chat', text: 42 }), 'bad-text'],
  ];
  for (const [input, reason] of bad) assert.deepEqual(validate(input), { ok: false, error: reason }, input);
});

test('protocol: extra fields are stripped (output is rebuilt)', () => {
  const r = validate(join({ evil: '<script>' }));
  assert.ok(r.ok);
  assert.equal('evil' in r.value, false);
});

test('protocol: createRoom validation', () => {
  assert.equal(validateCreateRoom({ name: 'X' }).ok, true);
  assert.equal(validateCreateRoom({ name: 'X', asteroids: 99 }).ok, false);
  assert.equal(validateCreateRoom({ name: '' }).ok, false);
  assert.equal(validateCreateRoom(null).ok, false);
});

test('token bucket: burst, refill, cap (fake clock)', () => {
  let t = 0;
  const b = new TokenBucket({ capacity: 3, perSecond: 2, now: () => t });
  assert.equal(b.take(), true);
  assert.equal(b.take(), true);
  assert.equal(b.take(), true);
  assert.equal(b.take(), false, 'bucket empty');
  t = 500; // +1 token
  assert.equal(b.take(), true);
  assert.equal(b.take(), false);
  t = 60_000; // would be 120 tokens, capped at 3
  for (let i = 0; i < 3; i++) assert.equal(b.take(), true);
  assert.equal(b.take(), false);
});

test('Room: join/leave/chat emit events; "empty" fires on last leave', () => {
  const room = new Room({ id: 'r', name: 'R', maxPlayers: 2 });
  const seen: string[] = [];
  for (const e of ['join', 'leave', 'chat', 'empty'] as const) room.on(e, () => seen.push(e));
  const a = room.join('A', fakeSocket());
  const b = room.join('B', fakeSocket());
  assert.throws(() => room.join('C', fakeSocket()), /room-full/);
  room.chat(a, 'hello');
  room.leave(a.id);
  room.leave(b.id);
  room.leave(b.id); // double leave is a no-op
  assert.deepEqual(seen, ['join', 'join', 'chat', 'leave', 'leave', 'empty']);
});

test('Room: emitting "error" does not crash (listener installed)', () => {
  const room = new Room({ id: 'r', name: 'R' });
  const orig = console.error;
  console.error = () => {};
  assert.doesNotThrow(() => room.emit('error', new Error('boom')));
  console.error = orig;
});

test('RoomManager: caps, deletes empty non-persistent rooms, keeps persistent', () => {
  const m = new RoomManager({ maxRooms: 2, maxPlayersPerRoom: 4 });
  const keep = m.create({ id: 'keep', name: 'K', persistent: true });
  const tmp = m.create({ name: 'Temp', asteroids: 2 });
  assert.throws(() => m.create({ name: 'third' }), /too-many-rooms/);
  tmp.leave(tmp.join('A', fakeSocket()).id);
  assert.equal(m.get(tmp.id), undefined, 'empty room deleted');
  keep.leave(keep.join('A', fakeSocket()).id);
  assert.ok(m.get('keep'), 'persistent room kept');
});

test('NdjsonTransform: object mode in, one line per event out', async () => {
  const chunks = [];
  const t = new NdjsonTransform();
  Readable.from([{ a: 1 }, { b: [2] }]).pipe(t);
  for await (const c of t) chunks.push(c.toString());
  assert.deepEqual(chunks, ['{"a":1}\n', '{"b":[2]}\n']);
});

test('config: defaults, overrides, and validation errors', () => {
  assert.equal(loadConfig({}).port, 3000);
  assert.equal(loadConfig({ PORT: '8080' }).port, 8080);
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ PORT: '99999' }), /PORT/);
  assert.throws(() => loadConfig({ MAX_ROOMS: '0' }), /MAX_ROOMS/);
});

test('EventEmitter: unhandled "error" event throws', async () => {
  const { EventEmitter } = await import('node:events');
  assert.throws(() => new EventEmitter().emit('error', new Error('boom')), /boom/);
});

test('slow-client policy: drops chat above threshold, keeps critical, closes at 4x', async () => {
  const { send } = await import('../src/ws.ts');
  const config = { slowClientBytes: 100 };
  const mk = fakeSocket;
  let s = mk(50); send(s, 'chat', config, false); assert.deepEqual(s.sent, ['chat'], 'under threshold: sent');
  s = mk(150); send(s, 'chat', config, false); assert.deepEqual(s.sent, [], 'over threshold: chat dropped');
  s = mk(150); send(s, 'roster', config, true); assert.deepEqual(s.sent, ['roster'], 'critical still sent');
  s = mk(500); send(s, 'roster', config, true); assert.equal(s.closed, 4005, 'far over: closed with SLOW_CLIENT');
  assert.deepEqual(s.sent, []);
});
