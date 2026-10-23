import { defineConfig } from '@playwright/test';

/**
 * Browser end-to-end tests.
 *  - local:  the browser-only demo (Vite dev server, IndexedDB, mock AI)
 *  - server: production build + bundled API on PGlite (dev login, mock AI)
 * Set PW_CHROMIUM_PATH to use a preinstalled Chromium instead of `npx playwright install`.
 */
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    viewport: { width: 1600, height: 960 },
    acceptDownloads: true,
    launchOptions: { executablePath },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'local', testMatch: /local\.spec\.ts/, use: { baseURL: 'http://localhost:5174' } },
    { name: 'server', testMatch: /server\.spec\.ts/, use: { baseURL: 'http://localhost:8790' } },
  ],
  webServer: [
    { command: 'npx vite --port 5174 --strictPort', url: 'http://localhost:5174', reuseExistingServer: !process.env.CI, timeout: 120_000 },
    { command: 'node scripts/e2e-server.mjs', url: 'http://localhost:8790/api/health', reuseExistingServer: !process.env.CI, timeout: 240_000 },
  ],
});
