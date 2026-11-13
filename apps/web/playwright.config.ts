import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run the real API and web app with the mock providers, so
 * they need neither Ollama nor the internet (CLAUDE.md).
 */
const ci = Boolean(process.env.CI);
// Ports of their own, so a dev server already running on 5173 or 8787 is never reused by mistake.
const webPort = 5317;
const apiPort = 8917;
const webOrigin = `http://127.0.0.1:${String(webPort)}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: webOrigin,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx tsx --conditions=@local-ai/source src/server.ts',
      cwd: '../api',
      url: `http://127.0.0.1:${String(apiPort)}/healthz`,
      env: {
        PROVIDERS: 'mock',
        // Nothing from a test run is kept on disk.
        DATABASE_PATH: ':memory:',
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        PORT: String(apiPort),
        ALLOWED_ORIGINS: webOrigin,
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // The production build, so the tests also run under its Content Security Policy.
      command: `npx vite build && npx vite preview --host 127.0.0.1 --port ${String(webPort)} --strictPort`,
      url: webOrigin,
      env: { API_TARGET: `http://127.0.0.1:${String(apiPort)}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
