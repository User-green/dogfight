// Constants both runtimes must agree on. Changing one here changes it for the client AND the server.
export const TICK_RATE = 30; // authoritative server ticks per second
export const TICK_DT = 1 / TICK_RATE; // fixed sim step, seconds (the client predicts with the SAME dt)
export const TICK_MS = 1000 / TICK_RATE;
export const ARENA = Object.freeze({ width: 1000, height: 1000 });
export const INPUT_REDUNDANCY = 3; // every input packet repeats the last 3 inputs (survives dropped packets)
export const MAX_INPUT_BACKLOG = 4; // server keeps at most this many unprocessed inputs per player
export const RESPAWN_SECONDS = 2;
