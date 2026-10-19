const { test, expect, expectNoSideScroll } = require('./fixtures/test');
const { PASSWORD } = require('./fixtures/data');

test.describe('login', () => {
  test('login page renders', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByPlaceholder('you@example.com')).toBeVisible();
    await expect(page.getByPlaceholder('••••••••')).toBeVisible();
    await expect(page.getByRole('button', { name: /Sign In/ })).toBeEnabled();
    await expectNoSideScroll(page, 'on the login page');
  });

  test('wrong password shows the error', async ({ page, mock, guard }) => {
    // The fake GoTrue answers 400 like the real one; Chrome logs that 400.
    mock.allowError(/\/auth\/v1\/token/, 400);
    guard.allowConsole(/status of 400/);
    await page.goto('/');
    await page.getByPlaceholder('you@example.com').fill('sam.worker@e2e.test');
    await page.getByPlaceholder('••••••••').fill('not-the-password');
    await page.getByRole('button', { name: /Sign In/ }).click();
    await expect(page.getByText('Invalid login credentials')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(mock.calls('/auth/v1/token', 'POST')).toHaveLength(1);
  });

  test('correct login lands in the worker portal', async ({ page, mock }) => {
    await page.goto('/');
    await page.getByPlaceholder('you@example.com').fill('sam.worker@e2e.test');
    await page.getByPlaceholder('••••••••').fill(PASSWORD);
    await page.getByRole('button', { name: /Sign In/ }).click();
    await expect(page.getByRole('button', { name: 'My Allocations' })).toBeVisible();
    await expect(page.getByText('👤 Sam Taylor')).toBeVisible();
    // The session is persisted under the key supabase-js derives from the host.
    const stored = await page.evaluate(k => window.localStorage.getItem(k), mock.storageKey);
    expect(JSON.parse(stored).user.email).toBe('sam.worker@e2e.test');
    // The profile lookup went to workers by email.
    expect(mock.calls('/rest/v1/workers', 'GET').some(c => /email=ilike\.sam\.worker@e2e\.test/.test(c.path))).toBe(true);
  });
});
