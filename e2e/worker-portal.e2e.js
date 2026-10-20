const { test, expect, expectNoSideScroll, openSignedIn } = require('./fixtures/test');
const { SITE_NAME } = require('./fixtures/data');

test('worker portal: every tab renders', async ({ page, mock, isMobile }) => {
  await openSignedIn(page, mock, 'worker');
  await expect(page.getByText('👤 Sam Taylor')).toBeVisible();

  // Default tab: today's allocation from the fixtures.
  await expect(page.getByText(SITE_NAME).first()).toBeVisible();
  await expect(page.getByText('Today', { exact: true })).toBeVisible();

  const tabs = [
    ['My Allocations', page.getByText(SITE_NAME).first()],
    ['My Timesheets', page.getByRole('button', { name: '+ New Daily Timesheet' })],
    ['Take 5', page.getByText('What task are you doing? *')],
    ['Clock In/Out', page.locator('[data-area="clock in / out"]')],
    ['Time off', page.getByText('🏖 Request time off')],
    ['Report incident', page.getByText(/Report an incident, near miss or hazard/)],
    ['Documents', page.locator('[data-area="documents"]')],
    ['Policies', page.locator('[data-area="policy file"]').filter({ hasText: 'Excavation SWMS' })],
    ['My Profile', page.locator('[data-area="push-alerts"]').filter({ hasText: 'Phone alerts' })],
  ];
  for (const [label, content] of tabs) {
    await test.step(label, async () => {
      await page.getByRole('button', { name: label }).click();
      await expect(content).toBeVisible();
      if (isMobile) await expectNoSideScroll(page, `on the "${label}" tab`);
    });
  }

  // My Timesheets shows the fixture's approved sheet with its plain-words status.
  await page.getByRole('button', { name: 'My Timesheets' }).click();
  await expect(page.getByText(/Accepted by Pat Supervisor/)).toBeVisible();
});
