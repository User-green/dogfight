# syntax=docker/dockerfile:1

# ---- stage 1: build the client (needs devDependencies: vite) ----
# slim (glibc), not alpine (musl): the vite/rollup build overflows musl's small default thread stack on zod's huge export lists
FROM node:24-slim AS build
WORKDIR /app
# Manifests first: this layer (and the npm ci below) is cached until a dependency changes, not on every source edit.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY tsconfig.base.json ./
COPY shared shared
COPY client client
RUN npm run build -w client

# ---- stage 2: runtime (production dependencies only, no vite/vitest/biome/playwright) ----
# Production deps are installed in a node image, then only the node BINARY is copied onto bare alpine:
# the stock node:alpine image carries npm/yarn/corepack (~40 MB we never run) and misses the 200 MB target.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev -w server -w shared --include-workspace-root=false && npm cache clean --force

# The shipped node binary carries symbols we never use; stripping them takes ~40 MB off.
FROM alpine:3.22 AS nodebin
RUN apk add --no-cache binutils
COPY --from=deps /usr/local/bin/node /node
RUN strip --strip-unneeded /node

FROM alpine:3.22 AS runtime
RUN apk add --no-cache libstdc++
COPY --from=nodebin /node /usr/local/bin/node
RUN adduser -D -u 1000 node
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
COPY --from=deps /app/node_modules node_modules
COPY shared/src shared/src
COPY server/src server/src
COPY --from=build /app/client/dist client/dist
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION HOST=0.0.0.0 PORT=3000 LOG_DIR=/app/server/logs STATIC_DIR=/app/client/dist
RUN mkdir -p /app/server/logs && chown -R node:node /app/server/logs
USER node
WORKDIR /app/server
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Exec form: Node is PID 1 and receives SIGTERM directly (a shell form or `npm start` would swallow it).
CMD ["node", "src/index.ts"]
