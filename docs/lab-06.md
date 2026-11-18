# Lab 6 — TypeScript: one schema, one type, both sides of the wire

## Run

```bash
npm install
npm run typecheck      # tsc --noEmit in shared, server, client (strict + noUncheckedIndexedAccess)
npm test               # shared 18, server 42, client 24 (Node 26 runs the .ts files directly)
npm run build          # vite build -> client/dist (Vite/esbuild strips types, it does NOT check them)
npm run check          # typecheck + test
/tmp/e2e-venv/bin/python e2e/lab4.py   # 13 checks, real server + two headless Firefox windows (silent)
/tmp/e2e-venv/bin/python e2e/lab5.py   # 11 checks
```

Every package is `.ts`. Tests and scripts too (`*.test.ts`, `vite.config.ts`, the netsim harness, the puzzles).

## What was built

| Piece | Where |
|---|---|
| strict base config (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`) | `tsconfig.base.json`, one `tsconfig.json` per package |
| branded `EntityId` / `Tick` / `Seq`, `assertNever`, `Result` | `shared/src/types.ts` |
| zod schemas -> inferred types -> `parseClientMessage` / `parseServerMessage` (never throw) | `shared/src/protocol.ts` |
| `Codec` interface, JSON + binary implementations, range/version checks | `shared/src/codec/` |
| `TypedTarget<M>` (typed `on` / `emit`), `Bus<GameEvents>` | `client/src/typed-target.ts`, `events.ts` |
| zod-validated `ServerConfig` | `server/src/config.ts` |
| CI workflow: typecheck, test, build | `.github/workflows/ci.yml` |

Casts in `src`: **4**, each commented: the brand constructor (`makeBrand`), the DOM `WebSocket` -> `WebSocketCtor` seam in `connection.ts`, `World.ofKind` (TS cannot narrow a union by a generic discriminant), and the `CustomEvent` detail in `TypedTarget.on`. `any` in `src`: **0** (grep). The tests add two documented casts (`ws` private `_receiver`, a timer handle type) plus a few `as` on `JSON.parse` / `res.json()` results.

## What TypeScript found

- `Ship.update(dt, input, arena)` overrode `Entity.update(dt, arena)` with a different signature: a Liskov violation. Renamed to `Ship.step`; the base keeps `update`.
- Ids, ticks and sequence numbers were interchangeable numbers; branding separates them.
- Unchecked `Map.get` and `arr[i]` in the client and server (`noUncheckedIndexedAccess`); each is now handled or asserted.
- The JSON codec never validated `ents`: anything array-shaped was accepted. The binary decoder built partial objects. Both now go through the schema or range checks.
- The hand-rolled server `validate` restated the protocol a second time; zod states it once and both sides use it.
- `socket.ctx` was an untyped property bolted onto the `ws` socket; it is a `WeakMap` now.
- Every `catch (e)` assumed `e.message`; `e` is `unknown` and is narrowed.
- `/api/rooms` JSON and the asset manifest were trusted blindly; both are zod-parsed now.
- A dead write: the client set `bullet.serverId`. **Correction:** I first called this dead because no source file read it, but `netcode.test.ts` read it to assert "twin adopted". I removed the field and the test now checks adoption through the latest snapshot (a predicted bullet is kept while the server snapshot holds a bullet with the same `fireSeq`).
- A dead numeric branch in the netgraph code.

## Three types worth explaining

1. **Discriminated union + `assertNever`.** `ServerMessage` is a union where each member has a literal `type`. After `case 'welcome':` TypeScript knows the payload shape; the `default` branch receives `never`, so adding a message type without handling it is a compile error, not a runtime surprise.
2. **Brands.** `type Seq = number & { readonly [brand]: 'Seq' }`. At runtime it is a number; at compile time you cannot pass a `Tick` where a `Seq` is expected, and you must go through `asSeq`, the one audited place the type system is lied to.
3. **`TypedTarget<M>`.** `on<K extends keyof M & string>(type: K, fn: (detail: M[K]) => void)`: `K` links the event name to its payload `M[K]`, so `bus.emit('scoreChanged', {score})` is checked on both sides. Gotcha found on the way: if `M` is an `interface` with an index signature, `keyof M & string` collapses to `string` and all checking is lost; a plain `type` alias works.

## Behaviour changes (runtime was meant to be identical)

- `validate` on the server now returns `{ ok, value | error }`; an `input` message carries `tick` / `inputs` directly.
- The client now drops invalid server messages (zod) instead of trusting them.
- `Vector2` stays mutable (the sim mutates it); `ReadonlyVec2` is provided for read-only use. This deviates from the "readonly Vector2" wording of the task.

## Framework decision (optional Svelte/Vue/React lobby + HUD)

Not done, on purpose. The lobby and HUD are about 150 lines of DOM code driven by two typed event sources. A framework would add a build plugin and a runtime for little gain, and the bundle is already 140 kB (43 kB gzip), most of it zod. What a framework would give: declarative rendering and less manual DOM diffing. What it would cost: bundle size and build complexity. Revisit if the UI grows.

## Not done / not verified

- Audio was not tested (the user asked for silent automation).
- `client/tests/e2e.py` (Lab 3 browser e2e) was not run: it needs a Vite dev server and reads `__lab3.world` / `__lab3.ship`, which have not existed since Lab 4/5. It is stale, not broken by this lab.
- `.github/workflows/ci.yml` has never run on GitHub: workflows only run from a repository root, and `dogfight/` is a subdirectory of the coursework repo. The same three commands were run locally.
- `docs/lab-04.md` still mentions `.js` / `.mjs` file names, which is historical.
- `e2e/lab4.py` had a stale check (`__lab3.ship`, gone since Lab 5); it now reads `__lab3.client.ship`.
