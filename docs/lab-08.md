# Lab 8 - Ship it (production process, hardening, container)

## Run

```bash
docker compose up --build                  # http://localhost:3000, production-like
docker build -t dogfight --build-arg APP_VERSION=$(git rev-parse --short HEAD) .
docker stop <container>                    # SIGTERM -> graceful exit
curl localhost:3000/health /ready /metrics
```

## What was built

| Piece | Where |
|---|---|
| pino JSON logs to stdout, `LOG_LEVEL`, events with `roomId` | `server/src/logger.ts`, all `console.*` replaced |
| Crash on unknown (`uncaughtException`/`unhandledRejection` -> log fatal, exit 1) | `server/src/index.ts` |
| `/health` (liveness + version), `/ready` (503 while draining), `/metrics` (prom-client) | `server/src/server.ts` |
| Origin allowlist (`ALLOWED_ORIGINS`) and per-IP cap (`MAX_CONNECTIONS_PER_IP`) at the handshake: 403 / 429 | `server/src/server.ts` (`verifyClient`) |
| Version stamp (`APP_VERSION`) in `/health` and a corner label in the client | server + `client/src/main.ts` |
| PWA manifest + minimal service worker | `client/public/` |
| Multi-stage Dockerfile, compose, `.dockerignore` | repo root |
| Tag-triggered release workflow (build + push to GHCR) | `.github/workflows/release.yml` (never run) |
| Hardening and chaos tests | `server/test/hardening.test.ts` |

## Measured in this session

- Image: **192 MB** (limit 200), runs as uid 1000, `HEALTHCHECK` reports healthy.
- `docker stop`: 0.37 s, exit code 0, logs show `server.shutdown` then `server.exit`. Exec-form `CMD`, so Node is PID 1 and gets SIGTERM.
- Tests: 126 pass (41 shared, 56 server, 29 client), 2 Playwright e2e pass.
- Chaos (automated): garbage flood of 1000 frames closes the abuser with 4000, is counted in `rejections`, and the other room records 0 tick overruns; a terminated client (no close frame) is removed from room and connection count.

## Things that went wrong on the way

- First image build failed in `vite build` with "Code is nested too deeply" inside zod, only in the alpine container. The same build works on the host. Switching the build stage to glibc (`node:24-slim`) fixed it. My explanation (musl's small default thread stack) is a hypothesis; I did not verify it directly.
- Stock `node:24-alpine` is 239 MB by itself, so the 200 MB goal was impossible with it. The runtime stage is bare alpine plus a copied, stripped node binary.

## NOT done (needs things I do not have)

- No public URL, no deploy, no WSS in front of a real proxy, no uptime monitor, no two remote players, no real-world RTT numbers, no demo video or hero GIF. These need hosting accounts and other people.
- `release.yml` has never run and its deploy step is a commented placeholder.
- PWA: manifest and service worker exist, but **no icons**, so browsers will not offer install. I did not draw any (supply a 192 and 512 px PNG and add them to the manifest). Install was not tested on a phone.
- Per-IP cap uses the socket address. Behind a reverse proxy every client shares the proxy's IP, so the cap would need `X-Forwarded-For` handling; not implemented.
- No Sentry; no `kill -STOP` experiment; the "server killed mid-match, clients reconnect" chaos test was not automated (the client reconnect logic is from Lab 4 and tested there).
- Single instance by design; sticky sessions and Redis are described in the task, not built.
