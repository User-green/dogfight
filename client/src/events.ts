import type { TypedTarget } from './typed-target.ts';

/** What the world tells the HUD and the audio. The sim never imports either: it only dispatches these. */
// A type alias, not an interface: only aliases are assignable to Record<string, unknown> (no implicit index signature on interfaces).
export type GameEvents = {
  fired: void;
  hit: void;
  exploded: void;
  scoreChanged: { score: number; delta: number };
};
export type Bus = TypedTarget<GameEvents>;
