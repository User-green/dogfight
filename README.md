# dogfight

[![ci](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)

The badge URL is a placeholder: the workflow has never run on GitHub (it is inert inside the coursework repo; see the note at the top of `.github/workflows/ci.yml`). Replace `OWNER/REPO` if this directory ever becomes its own repository.

Multiplayer browser dogfight: authoritative 30 Hz Node server, predicting client, shared deterministic simulation.

```bash
npm install
npm run check      # typecheck + lint + all tests
npm run coverage   # shared/ coverage with an 85% gate
npm run build && npm run e2e   # real server + two real browser contexts (Playwright, headless Chromium)
npm run dev:server # and, in another terminal, npm run dev:client
```

Per-lab notes live in `docs/`.
