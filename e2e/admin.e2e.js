const { test, expect, expectNoSideScroll, openSignedIn } = require('./fixtures/test');

const MENU_ITEMS = ['Time off requests', 'Policies', 'Safety', 'Documents', 'Reports'];
// The test admin is ticked as an allocator. Allocators never see pay (owner rule
// 2026-10-20), so the money pages must be missing from their menu.
const MONEY_ITEMS = ['Plant', 'Invoices', 'Payroll'];

test('admin: dashboard renders', async ({ page, mock }) => {
  await openSignedIn(page, mock, 'admin');
  await expect(page.getByText(/Good (morning|afternoon|evening)/)).toBeVisible();
  await expect(page.getByText('CBD PLANT & LABOUR', { exact: false }).first()).toBeVisible();
});

test('admin (phone): menu has the new pages and the 🔐 entry; top bar fits 360 px', async ({ page, mock, isMobile }) => {
  test.skip(!isMobile, 'phone layout only');
  await openSignedIn(page, mock, 'admin');
  await expect(page.getByText(/Good (morning|afternoon|evening)/)).toBeVisible();

  // The two-step entry is NOT in the phone top bar.
  const topBar = page.getByLabel('Toggle menu').locator('xpath=ancestor::div[2]');
  await expect(topBar.locator('[data-area="two-step login button"]')).toHaveCount(0);
  const bar = await topBar.evaluate(el => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    right: Math.max(...[...el.querySelectorAll('button')].map(b => b.getBoundingClientRect().right)),
    innerWidth: window.innerWidth,
  }));
  expect(bar.scrollWidth, 'top bar overflows sideways').toBeLessThanOrEqual(bar.clientWidth);
  expect(bar.right, 'a top-bar button sits past the screen edge').toBeLessThanOrEqual(bar.innerWidth);

  await page.getByLabel('Toggle menu').click();
  const sidebar = page.locator('[data-area="left sidebar"]');
  await expect(sidebar).toBeVisible();
  for (const label of MENU_ITEMS) {
    await expect(sidebar.getByRole('button', { name: label })).toBeVisible();
  }
  for (const label of MONEY_ITEMS) {
    await expect(sidebar.getByRole('button', { name: label })).toHaveCount(0);
  }
  const twoStep = sidebar.locator('[data-area="two-step login button"]');
  await expect(twoStep).toBeVisible();
  await expect(twoStep).toContainText('🔐');
  await expect(twoStep).toContainText(/two-step login/i);
  await expectNoSideScroll(page, 'with the menu open');
});

test('admin (desktop): sidebar shows the new pages; 🔐 sits in the top bar', async ({ page, mock, isMobile }) => {
  test.skip(isMobile, 'desktop layout only');
  await openSignedIn(page, mock, 'admin');
  const sidebar = page.locator('[data-area="left sidebar"]');
  await expect(sidebar).toBeVisible();
  for (const label of MENU_ITEMS) {
    await expect(sidebar.getByRole('button', { name: label })).toBeVisible();
  }
  for (const label of MONEY_ITEMS) {
    await expect(sidebar.getByRole('button', { name: label })).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: 'Two-step login' })).toBeVisible();
});

test('admin: Create Allocation flags a worker without the role\'s tickets', async ({ page, mock, isMobile }) => {
  await openSignedIn(page, mock, 'admin');
  await expect(page.getByText(/Good (morning|afternoon|evening)/)).toBeVisible();
  if (isMobile) await page.getByLabel('Toggle menu').click();
  await page.locator('[data-area="left sidebar"]').getByRole('button', { name: /^📋 Allocations/ }).click();
  await page.getByRole('button', { name: '+ Create Allocation' }).click();
  await expect(page.getByText('Create Allocation', { exact: true })).toBeVisible();

  await page.getByLabel('Sam Taylor').check();
  await page.getByLabel('Alex Morgan').check();
  // No chips before a role is chosen.
  await expect(page.getByText(/⚠ missing:/)).toHaveCount(0);

  await page.locator('select').filter({ has: page.locator('option', { hasText: 'Select a role…' }) })
    .selectOption('Operator - Excavator');

  // Sam has no tickets → both rules flag; Alex holds "Excavator (LE)" + a White Card → clean.
  await expect(page.getByText('⚠ missing: Excavator ticket')).toBeVisible();
  await expect(page.getByText('⚠ missing: White Card')).toBeVisible();
  const check = page.locator('[data-area="ticket check"]');
  await expect(check).toContainText('Sam Taylor');
  await expect(check).not.toContainText('Alex Morgan');
  if (isMobile) await expectNoSideScroll(page, 'with Create Allocation open');
});
