// Server-side AI players. A bot produces the SAME Input a human's keyboard would (thrust/turn/fire), and Match
// feeds it through the same `input()` path as a WebSocket packet, so the simulation cannot tell them apart.
import type { Input } from 'shared/protocol';
import { Kind } from 'shared/sim/entity';
import type { Ship } from 'shared/sim/ship';
import type { World } from 'shared/sim/world';
import { normAngle, wrapDelta } from 'shared/state';
import { ARENA } from 'shared/constants';
import { asSeq } from 'shared/types';

export type InputCommand = Pick<Input, 'thrust' | 'turn' | 'fire'>;

/** Anything that can decide what to press this tick: a human's key state, a bot, a replay. */
export interface PlayerInput {
  decide(world: World, ship: Ship): InputCommand;
}

const EVADE_RADIUS = 110;
const ENGAGE_RANGE = 450;
const AIM_TOLERANCE = 0.18; // rad
const IDLE: InputCommand = { thrust: false, turn: 0, fire: false };

interface Contact {
  dx: number;
  dy: number;
  dist: number;
}

function contact(ship: Ship, x: number, y: number): Contact {
  const dx = wrapDelta(ship.pos.x, x, ARENA.width);
  const dy = wrapDelta(ship.pos.y, y, ARENA.height);
  return { dx, dy, dist: Math.hypot(dx, dy) };
}

/** Turn command that rotates `ship` toward `bearing` the short way. */
function steer(ship: Ship, bearing: number): { turn: -1 | 0 | 1; error: number } {
  const error = normAngle(bearing - ship.angle);
  return { turn: Math.abs(error) < 0.05 ? 0 : error > 0 ? 1 : -1, error };
}

/** Chase the nearest other ship (or rock), shoot when lined up, and flee anything about to hit. */
export class Bot implements PlayerInput {
  decide(world: World, ship: Ship): InputCommand {
    if (!ship.alive) return IDLE;

    let rock: Contact | null = null;
    for (const a of world.ofKind(Kind.ASTEROID)) {
      const c = contact(ship, a.pos.x, a.pos.y);
      if (rock === null || c.dist < rock.dist) rock = c;
    }
    if (rock !== null && rock.dist < EVADE_RADIUS) {
      const away = Math.atan2(-rock.dy, -rock.dx);
      const { turn, error } = steer(ship, away);
      return { thrust: Math.abs(error) < 0.6, turn, fire: false };
    }

    let target: Contact | null = null;
    for (const other of world.ofKind(Kind.SHIP)) {
      if (other === ship) continue;
      const c = contact(ship, other.pos.x, other.pos.y);
      if (target === null || c.dist < target.dist) target = c;
    }
    target ??= rock;
    if (target === null) return { thrust: true, turn: 1, fire: false };

    const { turn, error } = steer(ship, Math.atan2(target.dy, target.dx));
    const aligned = Math.abs(error) < AIM_TOLERANCE;
    return { thrust: aligned && target.dist > 160 && ship.vel.length() < 180, turn, fire: aligned && target.dist < ENGAGE_RANGE };
  }
}

/** Per-bot bookkeeping: the seq counter every client keeps. */
export class BotSeat {
  seq = 0;
  readonly playerId: string;
  readonly brain: PlayerInput;
  constructor(playerId: string, brain: PlayerInput) {
    this.playerId = playerId;
    this.brain = brain;
  }

  nextInput(world: World, ship: Ship): Input {
    return { seq: asSeq(++this.seq), ...this.brain.decide(world, ship) };
  }
}
