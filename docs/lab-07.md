# Lab 7 - Quality, tests, bots, load

## Run

```bash
npm run check      # typecheck + biome + all tests
npm run coverage   # shared coverage with thresholds (96% actual)
npm run e2e        # Playwright: real server, real production build, headless Chromium
# load test (silent, no browser):
PORT=3911 MAX_PLAYERS_PER_ROOM=200 MAX_BOTS=200 node server/src/index.ts &
curl -X POST -d '{"count":64}' http://127.0.0.1:3911/api/rooms/alpha/bots
node server/scripts/loadtest.ts 64 10 http://127.0.0.1:3911
```

## What was built

| Piece | Where |
|---|---|
| Vitest migration, fast-check properties, fake-timer loop tests | `shared/test`, `client/tests` |
| Biome lint, CI workflow, Playwright two-player spec | `biome.json`, `.github/workflows/ci.yml`, `e2e/` |
| Server bots behind a `PlayerInput` interface; `/api/rooms/:id/bots` (cap `MAX_BOTS`) | `server/src/bot.ts`, `match.ts`, `server.ts` |
| `/api/stats` now reports `elu`, `heapUsed`, `rss` | `server/src/server.ts` |
| Load-test client | `server/scripts/loadtest.ts` |

## Load test (one room, N bots + N idle ws clients, 10 s each)

| N | tick EWMA p99 (ms) | tick max (ms) | ELU | RSS MB | bytes/s |
|---|---|---|---|---|---|
| 8 | 4.3 | 11.6 | 0.09 | 121 | 2.3 M |
| 32 | 9.4 | 31.1 | 0.23 | 131 | 36.8 M |
| 64 | 31.3 | 82.7 | 0.67 | 151 | 142 M |
| 128 | 131 | 178 | 0.80 | 226 | 152 M |

The tick budget is 33.3 ms. Capacity in this setup is about 64 players per room: the p99 touches the budget, and 128 is far over.
Bytes/s grows roughly with N squared, because every snapshot contains every entity and goes to every client. At 128 the number flattens only because the server is overloaded and ticks slip.

## Honest limits

- "p99" is the 99th percentile of one-per-second samples of the tick EWMA (10 samples), not of every tick. It is a coarse estimate. `tick max` is the real worst case.
- Server and load generator share one machine (aarch64), so numbers are relative, not absolute.
- Not done: `--cpu-prof` flame graph, spatial hash, object pooling, Web Worker experiment, `performance.mark` client instrumentation. No bottleneck was profiled, so no optimisation was applied; the likely culprits (O(n^2) collision, full-state snapshots per client) are hypotheses, not measurements.
- CI has never run on GitHub; the README badge is a placeholder.
- Biome replaces typed ESLint (TS 7 has no JS API). Audio is untested (silent automation only).
