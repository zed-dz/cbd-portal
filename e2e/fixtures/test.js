// Shared test fixture. Every test automatically gets:
//   - `mock`  : the fake Supabase (fixtures/supabase-mock.js), installed before
//               the first navigation; its request log is attached to the report
//   - `guard` : collects uncaught page errors and console errors; at the end of
//               the test it fails on any that were not explicitly allowed, on
//               any unexpected 4xx/5xx from the mock, and — on the phone
//               project — on horizontal page scroll.
const base = require('@playwright/test');
const { installSupabaseMock } = require('./supabase-mock');

const { expect } = base;

async function pageWidths(page) {
  return page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
}

// "No sideways scroll" — the page itself never scrolls horizontally on a phone
// (a table may scroll inside its own box; that does not widen the document).
async function expectNoSideScroll(page, where = '') {
  const w = await pageWidths(page);
  expect(w.scrollWidth, `horizontal page scroll ${where}`.trim()).toBeLessThanOrEqual(w.innerWidth);
}

const test = base.test.extend({
  mock: async ({ page, context }, use, testInfo) => {
    const mock = await installSupabaseMock(page, context);
    await use(mock);
    const unknown = mock.unknownRoutes();
    if (unknown.length) testInfo.annotations.push({ type: 'unmocked Supabase routes (answered 200 [])', description: unknown.join(' | ') });
    await testInfo.attach('supabase-requests.json', { body: JSON.stringify(mock.log, null, 2), contentType: 'application/json' });
  },

  guard: [async ({ page, mock, isMobile }, use, testInfo) => {
    const problems = [];
    const allowed = [];
    page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
    page.on('console', msg => {
      if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
    });
    await use({
      // Allow a console error the test provokes on purpose (e.g. a 400 on a wrong password).
      allowConsole(re) { allowed.push(re); },
      problems,
    });
    if (testInfo.status !== testInfo.expectedStatus) return; // already failed; keep the first error
    expect(problems.filter(p => !allowed.some(re => re.test(p))), 'uncaught page errors / console errors').toEqual([]);
    expect(mock.unexpectedErrors(), 'unexpected 4xx/5xx answers from the mocked Supabase').toEqual([]);
    if (isMobile && !page.isClosed() && page.url().startsWith('http')) await expectNoSideScroll(page, 'at the end of the test');
  }, { auto: true }],
});

// Open the portal already signed in as 'worker' or 'admin'.
async function openSignedIn(page, mock, kind) {
  await mock.seedSession(kind);
  await page.goto('/');
}

module.exports = { test, expect, expectNoSideScroll, openSignedIn };
