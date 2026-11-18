import { defineConfig } from '@playwright/test';

const PORT = 3222;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, browserName: 'chromium', launchOptions: { args: ['--mute-audio'] } },
  // The real server serves the real production build: nothing mocked.
  webServer: {
    command: 'npm run build && node server/src/index.ts',
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PORT: String(PORT), HOST: '127.0.0.1', STATIC_DIR: 'client/dist', LOG_DIR: '.e2e-logs' },
  },
});
