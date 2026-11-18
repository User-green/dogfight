import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

// Dev-only helper to test the loading screen: /__slow/<ms>/<path> serves <path> after <ms> milliseconds.
const slowPlugin: Plugin = {
  name: 'slow-assets',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const m = /^\/__slow\/(\d+)(\/.*)$/.exec(req.url ?? '');
      if (!m) return next();
      setTimeout(() => {
        req.url = m[2];
        next();
      }, Number(m[1]));
    });
  },
};

export default defineConfig({
  root: '.',
  plugins: [slowPlugin],
  build: { outDir: 'dist' },
  server: {
    // In development Vite serves the client and forwards API + WebSocket traffic to the Node server.
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000',
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
});
