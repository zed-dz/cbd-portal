// Live smoke — public checks only. Run by .github/workflows/live-smoke.yml.
const { test, expect } = require('@playwright/test');

test('live: login page loads on a phone with no console errors', async ({ page }) => {
  const problems = [];
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });

  const res = await page.goto('/', { waitUntil: 'load' });
  expect(res.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByPlaceholder('you@example.com')).toBeVisible();
  await expect(page.getByRole('button', { name: /Sign In/ })).toBeVisible();

  const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(w.sw, 'horizontal scroll at 360 px').toBeLessThanOrEqual(w.iw);
  await page.waitForLoadState('networkidle').catch(() => {});
  expect(problems).toEqual([]);
});

test('live: security headers are enforced', async ({ request }) => {
  const res = await request.get('/', { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  const h = res.headers();

  expect(h['permissions-policy'] || '').toContain('camera=(self)');

  expect(h['content-security-policy'], 'CSP must be enforced (not only Report-Only)').toBeTruthy();
  const scriptSrc = h['content-security-policy'].split(';').map(s => s.trim()).find(s => s.startsWith('script-src ')) || '';
  expect(scriptSrc).toContain("'self'");
  expect(scriptSrc).not.toContain('unsafe-inline');
  expect(scriptSrc).not.toContain('unsafe-eval');
});
