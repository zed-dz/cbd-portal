// Live smoke: public checks against the deployed portal (no login, no data,
// no secrets). Kept out of the normal suite — its tests are *.live.js so the
// mocked e2e run (playwright.config.js, *.e2e.js) never touches the internet.
//
//   npm run e2e:live                       # https://portal.cbdpnl.com.au
//   LIVE_URL=https://other.host npm run e2e:live
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e/live',
  testMatch: '**/*.live.js',
  retries: process.env.CI ? 2 : 0,
  timeout: 45_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-live' }]],
  outputDir: 'test-results-live',
  use: {
    baseURL: process.env.LIVE_URL || 'https://portal.cbdpnl.com.au',
    browserName: 'chromium',
    viewport: { width: 360, height: 740 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: devices['Pixel 5'].userAgent,
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
