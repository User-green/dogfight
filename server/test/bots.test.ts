import { describe, expect, test } from 'vitest';
import { Kind } from 'shared/sim/entity';
import { Match } from '../src/match.ts';
import { Bot, type PlayerInput } from '../src/bot.ts';
import { loadConfig } from '../src/config.ts';
import { createGameServer } from '../src/server.ts';

const runTicks = (m: Match, n: number) => {
  for (let i = 0; i < n; i++) m.tickOnce();
};

describe('bots', () => {
  test('a bot is an ordinary player: it has a ship and its inputs go through the same queue as a socket', () => {
    const m = new Match({ seed: 3, asteroids: 3 });
    const id = m.addBot();
    expect(m.players.get(id)?.ship.kind).toBe(Kind.SHIP);
    runTicks(m, 5);
    expect(m.stats.inputsAccepted).toBe(5);
    expect(m.players.get(id)?.ack).toBe(5);
  });

  test('bots move, shoot and survive for 20 simulated seconds without crashing the tick', () => {
    const m = new Match({ seed: 11, asteroids: 5 });
    for (let i = 0; i < 8; i++) m.addBot();
    let fired = 0;
    for (let t = 0; t < 600; t++) {
      m.tickOnce();
      fired = Math.max(fired, [...m.world.ofKind(Kind.BULLET)].length);
    }
    expect(fired).toBeGreaterThan(0);
    const moved = [...m.players.values()].filter((p) => p.ship.vel.length() > 0);
    expect(moved.length).toBeGreaterThan(0);
  });

  test('the sim cannot tell: same seed + same bots => identical world hash twice', () => {
    const snap = () => {
      const m = new Match({ seed: 5, asteroids: 4 });
      for (let i = 0; i < 4; i++) m.addBot();
      runTicks(m, 300);
      return [...m.world].map((e) => `${e.kind}:${e.pos.x.toFixed(4)},${e.pos.y.toFixed(4)}`).join('|');
    };
    expect(snap()).toBe(snap());
  });

  test('any PlayerInput can drive a ship (the interface, not the class, is the contract)', () => {
    const m = new Match({ seed: 1, asteroids: 0 });
    const spinner: PlayerInput = { decide: () => ({ thrust: false, turn: 1, fire: false }) };
    const id = m.addBot(spinner);
    const before = m.players.get(id)?.ship.angle ?? 0;
    runTicks(m, 10);
    expect(m.players.get(id)?.ship.angle).toBeGreaterThan(before);
  });

  test('a dead bot presses nothing', () => {
    const m = new Match({ seed: 1, asteroids: 0 });
    const id = m.addBot();
    const ship = m.players.get(id)?.ship;
    if (!ship) throw new Error('no ship');
    ship.alive = false;
    expect(new Bot().decide(m.world, ship)).toEqual({ thrust: false, turn: 0, fire: false });
  });

  test('removeBots removes ships from the world too', () => {
    const m = new Match({ seed: 1, asteroids: 0 });
    m.addBot();
    m.addBot();
    expect(m.removeBots(1)).toBe(1);
    expect(m.bots.size).toBe(1);
    expect(m.removeBots()).toBe(1);
    expect([...m.world.ofKind(Kind.SHIP)]).toHaveLength(0);
  });
});

describe('POST /api/rooms/:id/bots', () => {
  async function start(maxBots: number) {
    const server = createGameServer(loadConfig({}, { port: 0, host: '127.0.0.1', maxBots }));
    const addr = await server.listen();
    return { server, base: `http://127.0.0.1:${addr.port}` };
  }
  const post = (base: string, room: string, body: unknown) => fetch(`${base}/api/rooms/${room}/bots`, { method: 'POST', body: JSON.stringify(body) });

  test('adds N bots, enforces the cap, validates input, can remove them', async (t) => {
    const s = await start(5);
    t.onTestFinished(() => s.server.stop());
    const ok = await post(s.base, 'alpha', { count: 3 });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ room: 'alpha', bots: 3 });
    expect((await post(s.base, 'alpha', { count: 3 })).status).toBe(409);
    expect((await post(s.base, 'alpha', { count: 0 })).status).toBe(400);
    expect((await post(s.base, 'alpha', { count: 1.5 })).status).toBe(400);
    expect((await post(s.base, 'alpha', { count: 99 })).status).toBe(400);
    expect((await post(s.base, 'alpha', {})).status).toBe(400);
    expect((await post(s.base, 'nope', { count: 1 })).status).toBe(404);
    expect((await fetch(`${s.base}/api/rooms/alpha/bots`, { method: 'GET' })).status).toBe(405);
    const del = await fetch(`${s.base}/api/rooms/alpha/bots`, { method: 'DELETE' });
    expect(await del.json()).toEqual({ room: 'alpha', removed: 3 });
    const stats = (await (await fetch(`${s.base}/api/stats`)).json()) as { matches: Record<string, { players: number }> };
    expect(stats.matches['alpha']?.players).toBe(0);
  });
});
