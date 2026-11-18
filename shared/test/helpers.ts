import { World } from '../src/sim/world.ts';
import { Ship } from '../src/sim/ship.ts';
import { Asteroid } from '../src/sim/asteroid.ts';
import { Pickup } from '../src/sim/pickup.ts';
import { Vector2 } from '../src/sim/vector.ts';
import { ARENA, TICK_DT } from '../src/constants.ts';
import { toShipInput, type Input } from '../src/protocol.ts';
import { asSeq, type EntityId } from '../src/types.ts';

/** Build the same little arena every time: N ships, some asteroids, 2 pickups. All randomness from `seed`. */
export interface WorldOptions {
  seed?: number;
  ships?: number;
  asteroids?: number;
}

export function makeWorld({ seed = 7, ships = 2, asteroids = 6 }: WorldOptions = {}): { world: World; shipIds: EntityId[] } {
  const world = new World({ seed });
  const shipIds: EntityId[] = [];
  for (let i = 0; i < ships; i++) {
    const s = new Ship({ pos: world.randomSafeSpot(ARENA, 0) });
    world.spawn(s);
    shipIds.push(s.id);
  }
  for (let i = 0; i < asteroids; i++) {
    world.spawn(new Asteroid({ pos: new Vector2(world.rng() * ARENA.width, world.rng() * ARENA.height), tier: 3, rng: world.rng }));
  }
  world.spawn(new Pickup({ pos: new Vector2(250, 250), type: 'SHIELD' }));
  world.spawn(new Pickup({ pos: new Vector2(750, 750), type: 'RAPID_FIRE' }));
  return { world, shipIds };
}

/** A fixed script of inputs: a pure function of (tick, shipIndex), so two runs get identical input. */
const TURNS = [-1, 0, 1] as const;

export function scriptedInput(tick: number, k: number): Input {
  return {
    seq: asSeq(tick + 1),
    thrust: (tick + k * 7) % 40 < 25,
    turn: TURNS[Math.floor((tick + k * 11) / 13) % 3] ?? 0,
    fire: (tick + k * 5) % 9 === 0,
  };
}

export function run(world: World, shipIds: readonly EntityId[], ticks: number): void {
  for (let t = 0; t < ticks; t++) {
    const inputs = new Map(shipIds.map((id, k) => [id, toShipInput(scriptedInput(t, k))]));
    world.step(TICK_DT, ARENA, inputs);
  }
}
