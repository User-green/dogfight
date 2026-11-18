import type { World } from './sim/world.ts';
import { snapshotEntities } from './state.ts';

/**
 * Hash of the whole replicated world state: FNV-1a over the raw IEEE-754 bytes of every number.
 * Two runs agree on this hash only if they agree on every bit of state, which is what "deterministic" means.
 */
export function worldHash(world: World): string {
  const nums: number[] = [world.tick, world.score];
  for (const s of snapshotEntities(world)) {
    for (const v of Object.values(s)) nums.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }
  const bytes = new Uint8Array(new Float64Array(nums).buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
