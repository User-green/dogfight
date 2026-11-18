import { test } from 'vitest';
import assert from 'node:assert/strict';
import { simulate, correctionStats, pilot, stats } from './netsim-harness.ts';
import type { ClientConfig } from '../src/net/gameclient.ts';
import type { InputState } from '../src/input.ts';
import { Ship } from 'shared/sim/ship';
import { Kind } from 'shared/sim/entity';
import { wrapDelta } from 'shared/state';

type Stats = ReturnType<typeof stats>;
const fmt = (s: Stats) => `n=${s.n} mean=${s.mean.toFixed(4)} p95=${s.p95.toFixed(4)} max=${s.max.toFixed(4)}`;

test('M2: at 100 ms RTT, open space, no jitter: corrections are ~0 (quantization only)', () => {
  const r = simulate({ lag: 100 });
  const c = correctionStats(r.client);
  console.log('  clean 100ms   :', fmt(c));
  assert.ok(c.n > 200, 'many snapshots measured');
  assert.ok(c.p95 < 0.05, `p95 correction ${c.p95}`);
  assert.ok(c.max < 0.5, `max correction ${c.max}`);
});

test('M2: JSON codec (no quantization) is even closer to zero than binary', () => {
  const cj = correctionStats(simulate({ lag: 100, codec: 'json' }).client);
  console.log('  json 100ms    :', fmt(cj));
  assert.ok(cj.max < 1e-6, `JSON keeps full doubles, corrections must be float noise: ${cj.max}`);
});

test('M3 check: 100 ms +- 30 ms jitter and 2% loss per direction: still small corrections (redundant inputs absorb loss)', () => {
  const r = simulate({ lag: 100, jitter: 30, drop: 2, seconds: 30 });
  const c = correctionStats(r.client);
  console.log('  100+-30, 2%   :', fmt(c), 'starved', r.match.stats.starved, 'dropped', r.match.stats.inputsDropped);
  assert.ok(c.p95 < 3, `p95 ${c.p95}`);
  // The only large corrections are respawn teleports (the ship died and the server moved it): a handful at most, not a steady drift.
  const teleports = r.client.m.corrections.filter((x) => x.mag > 100).length;
  assert.ok(teleports <= 2, `${teleports} teleport-sized corrections`);
  const rest = r.client.m.corrections.filter((x) => x.mag <= 100);
  const mean = rest.reduce((a, x) => a + x.mag, 0) / rest.length;
  assert.ok(mean < 1, `mean without respawns ${mean}`);
});

test('M2: the determinism experiment: Math.random() in integrate makes corrections grow by orders of magnitude', () => {
  const good = correctionStats(simulate({ lag: 100 }).client);
  const original = Ship.prototype.step;
  Ship.prototype.step = function (this: Ship, dt, input, arena) {
    original.call(this, dt, input, arena);
    this.vel.x += (Math.random() - 0.5) * 20 * dt;
    this.vel.y += (Math.random() - 0.5) * 20 * dt;
  };
  let bad: Stats;
  try {
    bad = correctionStats(simulate({ lag: 100 }).client);
  } finally {
    Ship.prototype.step = original;
  }
  console.log('  deterministic :', fmt(good));
  console.log('  Math.random() :', fmt(bad));
  assert.ok(bad.mean > good.mean * 50 && bad.mean > 0.01, `broken ${bad.mean} vs good ${good.mean}`);
});

test('M1 vs M2: pressing thrust is visible after ONE step with prediction, after ~RTT without', () => {
  const press = 60; // tick at which thrust goes down
  const keys = (t: number): InputState => ({ thrust: t >= press, rotateLeft: false, rotateRight: false, fire: false });
  const firstMove = (config: Partial<ClientConfig>): number => {
    let found: number | null = null;
    simulate({ lag: 100, seconds: 6, keys, config, onFrame: ({ clock, entities, client }) => {
      if (found !== null || clock < press * 33.34) return;
      const ship = entities.find((e) => e.kind === Kind.SHIP && e.id === client.shipId);
      if (ship && ship.vel.length() > 1) found = clock - press * 33.34;
    } });
    if (found === null) throw new Error('the ship never moved');
    return found;
  };
  const predicted = firstMove({ predict: true });
  const dumb = firstMove({ predict: false, interpolate: false });
  console.log(`  thrust visible after: predicted ${predicted.toFixed(0)} ms, snapshots-only ${dumb.toFixed(0)} ms`);
  assert.ok(predicted <= 50, `prediction should react within one step, got ${predicted}`);
  assert.ok(dumb >= 100, `without prediction expect >= RTT (100 ms), got ${dumb}`);
});

test('M2: without reconciliation the ship rubber-bands (snaps back by the in-flight distance)', () => {
  const withRec = correctionStats(simulate({ lag: 100, config: { reconcile: true } }).client);
  const without = correctionStats(simulate({ lag: 100, config: { reconcile: false } }).client);
  console.log('  reconcile on  :', fmt(withRec));
  console.log('  reconcile off :', fmt(without));
  assert.ok(without.mean > withRec.mean * 20 && without.p95 > withRec.p95 * 100, `off ${without.mean} on ${withRec.mean}`);
});

test('M3: interpolation makes a remote ship move smoothly; the newest-snapshot view stutters at 30 Hz', () => {
  const steps = (config: Partial<ClientConfig>): number[] => {
    let last: { x: number; y: number } | null = null;
    const d: number[] = [];
    simulate({ lag: 100, withRival: true, seconds: 10, config, onFrame: ({ clock, entities, rival }) => {
      if (clock < 2000) return;
      const s = entities.find((e) => e.kind === Kind.SHIP && e.id === rival?.ship.id);
      if (!s) return;
      if (last) d.push(Math.hypot(wrapDelta(last.x, s.pos.x, 1000), wrapDelta(last.y, s.pos.y, 1000)));
      last = { x: s.pos.x, y: s.pos.y };
    } });
    return d.filter((x) => x < 60);
  };
  const cv = (a: number[]): number => {
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length) / m;
  };
  const smooth = steps({ interpolate: true });
  const jerky = steps({ interpolate: false });
  console.log(`  frame-step variation (std/mean): interpolated ${cv(smooth).toFixed(3)}, newest-snapshot ${cv(jerky).toFixed(3)}`);
  assert.ok(cv(smooth) < cv(jerky) / 3, 'interpolation should cut step variation at least 3x');
});

test('M3: remote entities appear only when their bracket arrives, and vanish when they are gone (no leaks)', () => {
  const r = simulate({ lag: 100, withRival: true, asteroids: 4, seconds: 20 });
  const live = new Set([...r.match.world].filter((e) => e.alive).map((e) => e.id));
  for (const id of r.client.proxies.keys()) assert.ok(live.has(id) || r.client.buffer.some((s) => s.ents.has(id)), `proxy ${id} has no source`);
  assert.ok(r.client.proxies.size <= live.size + 10, 'proxy table does not grow without bound');
});

test('M3: own bullet is predicted at once, adopts the server twin, and never doubles', () => {
  const keys = (t: number): InputState => ({ thrust: false, rotateLeft: false, rotateRight: false, fire: t === 40 });
  let firstSeen: number | null = null;
  let twinAdopted = false;
  let doubled = false;
  simulate({ lag: 100, seconds: 3, keys, onFrame: ({ clock, entities, client }) => {
    const mine = entities.filter((e) => e.kind === Kind.BULLET && (e.shooterId === client.shipId));
    if (mine.length && firstSeen === null) firstSeen = clock;
    if (mine.length > 1) doubled = true;
    // adopted = a predicted bullet is still kept while the latest snapshot holds the server's bullet with the same fireSeq
    const serverFseqs = new Set<number>();
    for (const e of client.latest?.ents.values() ?? []) if (e.kind === Kind.BULLET && e.shooter === client.shipId) serverFseqs.add(e.fseq);
    if (client.predBullets.some((b) => serverFseqs.has(b.fireSeq))) twinAdopted = true;
  } });
  if (firstSeen === null) throw new Error('the predicted bullet was never drawn');
  const fireAt = 40 * 33.34 + 7;
  console.log(`  bullet drawn ${(firstSeen - fireAt).toFixed(0)} ms after the key press; server twin adopted: ${twinAdopted}`);
  assert.ok(firstSeen - fireAt < 40, 'predicted bullet appears within a step');
  assert.ok(twinAdopted, 'ack arrives and the twin is matched by fireSeq');
  assert.equal(doubled, false, 'predicted + server bullet are never both drawn');
});

test('M2: input packets: 22 bytes (binary) and the server ack tracks the client seq', () => {
  const r = simulate({ lag: 100, seconds: 5, codec: 'binary' });
  // the first two packets carry fewer than 3 inputs (nothing older exists yet), so the mean is a hair under 22
  const perPacket = r.client.m.bytesOut / r.client.m.inputsSent;
  assert.ok(perPacket <= 22 && perPacket > 21.5, `binary input packet size ${perPacket}`);
  assert.ok(r.client.seq - r.me.ack < 12, `ack ${r.me.ack} should trail seq ${r.client.seq} by about RTT ticks`);
});

test('stats helper sanity', () => {
  assert.deepEqual(stats([]), { n: 0, mean: 0, p95: 0, max: 0 });
  assert.equal(stats([1, 2, 3]).max, 3);
  assert.equal(typeof pilot(0).thrust, 'boolean');
});
