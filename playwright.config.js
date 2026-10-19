// Browser tests (e2e/*.e2e.js). They run against a build made with a FAKE
// Supabase URL (npm run e2e:build → build-e2e/) and answer every Supabase call
// from fixtures — no production data, no secrets. The header of
// e2e/fixtures/supabase-mock.js lists what the fake backend speaks.
//
//   npm run e2e:build   # once per code change
//   npm run e2e         # both projects: phone (360x740 touch) + desktop
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 4173);

module.exports = defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.js',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
    // The app registers /sw.js in production builds; a service worker would
    // answer requests before page.route sees them.
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'phone',
      use: {
        browserName: 'chromium',
        viewport: { width: 360, height: 740 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent: devices['Pixel 5'].userAgent,
      },
    },
    {
      name: 'desktop',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: {
    command: 'node e2e/serve.js',
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
