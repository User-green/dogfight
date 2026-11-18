# dogfight

[![ci](https://github.com/User-green/dogfight/actions/workflows/ci.yml/badge.svg)](https://github.com/User-green/dogfight/actions/workflows/ci.yml)

Multiplayer browser dogfight: authoritative 30 Hz Node server, predicting client, shared deterministic simulation.

```bash
npm install
npm run check      # typecheck + lint + all tests
npm run coverage   # shared/ coverage with an 85% gate
npm run build && npm run e2e   # real server + two real browser contexts (Playwright, headless Chromium)
npm run dev:server # and, in another terminal, npm run dev:client
```

Per-lab notes live in `docs/`.


## Production (Lab 8)

```bash
docker compose up --build   # http://localhost:3000
```

Endpoints: `/health` (liveness, version), `/ready` (readiness), `/metrics` (Prometheus). Config via env: `ALLOWED_ORIGINS`, `MAX_CONNECTIONS_PER_IP`, `TRUST_PROXY`, `LOG_LEVEL`, `APP_VERSION`, `MAX_ROOMS`, `MAX_PLAYERS_PER_ROOM`. See `docs/lab-08.md` for measurements and what is not done (no public deployment yet).
