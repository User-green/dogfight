// The shapes of the two JSON files the client loads at boot. Parsed with zod: the file is outside the type system,
// so `fetchJson` returns `unknown` and these schemas are what turn it into something typed (or a clear error).
import { z } from 'zod';

const AssetSpecSchema = z.object({ url: z.string(), required: z.boolean() });
const FrameSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]); // sx, sy, sw, sh

export const ManifestSchema = z.object({
  sprites: AssetSpecSchema.extend({ frames: z.record(z.string(), FrameSchema) }),
  arena: AssetSpecSchema,
  sounds: z.record(z.string(), AssetSpecSchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;
export type AssetSpec = z.infer<typeof AssetSpecSchema>;
export type Frames = Manifest['sprites']['frames'];

export const ArenaConfigSchema = z.object({ width: z.number(), height: z.number(), shipSafeRadius: z.number().optional() });
export type ArenaConfig = z.infer<typeof ArenaConfigSchema>;

/** What loadAll actually needs from a manifest: every part optional (tests load one asset at a time). */
export interface LoadManifest {
  sprites?: AssetSpec;
  arena?: AssetSpec;
  sounds?: Record<string, AssetSpec>;
}
