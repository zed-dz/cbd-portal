const { test, expect, expectNoSideScroll, openSignedIn } = require('./fixtures/test');
const { IDS, CLIENT_NAME, SITE_NAME, TODAY, TAKE5_DAY, noTake5Day } = require('./fixtures/data');

const RPC_PATH = '/rest/v1/rpc/save_daily_timesheet';

async function openNewTimesheet(page, mock) {
  await openSignedIn(page, mock, 'worker');
  await page.getByRole('button', { name: 'My Timesheets' }).click();
  await page.getByRole('button', { name: '+ New Daily Timesheet' }).click();
  await expect(page.getByText('Daily Timesheet', { exact: true })).toBeVisible();
  // Client / project / role come from today's allocation in the fixtures.
  await expect(page.getByText(/Pre-filled from your allocation/)).toBeVisible();
}

async function fillShift(page, { date, start, end, tasks }) {
  if (date) await page.locator('input[type="date"]').first().fill(date);
  await page.locator('input[type="time"]').nth(0).fill(start);
  await page.locator('input[type="time"]').nth(1).fill(end);
  await page.getByPlaceholder('Briefly describe the tasks you completed today').fill(tasks);
}

const finishedEarly = (page, answer) => page.locator('[data-area="finished early question"]').getByRole('radio', { name: answer });
const submit = page => page.getByRole('button', { name: 'Submit', exact: true });

test('daily timesheet: early-finish answer required, 13 h shift needs the fatigue tick, then saves', async ({ page, mock, isMobile }) => {
  await openNewTimesheet(page, mock);
  await fillShift(page, { start: '06:00', end: '19:00', tasks: 'Traffic control set-up and pack-down' });

  // 1. "Did you finish work early?" is required.
  await submit(page).click();
  await expect(page.getByText('Please answer "Did you finish work early?" (Yes or No).')).toBeVisible();
  expect(mock.calls(RPC_PATH)).toHaveLength(0);

  // 2. 13 hours > 12 → the fatigue box, and Submit is refused until ticked.
  const fatigue = page.locator('[data-area="fatigue check"]');
  await expect(fatigue).toBeVisible();
  await expect(fatigue).toContainText('Fatigue check');
  await expect(fatigue).toContainText('13h in one shift (limit 12h)');
  await finishedEarly(page, 'No').check();
  await submit(page).click();
  await expect(page.getByText(/Fatigue check: tick "I confirm these hours are correct"/)).toBeVisible();
  expect(mock.calls(RPC_PATH)).toHaveLength(0);
  if (isMobile) await expectNoSideScroll(page, 'with the timesheet form open');

  // 3. Tick → the save RPC and the office alert both go out.
  await fatigue.getByLabel('I confirm these hours are correct').check();
  const rpcReq = page.waitForRequest(r => r.url().includes(RPC_PATH) && r.method() === 'POST');
  const alertReq = page.waitForRequest(r => r.url().includes('/functions/v1/notify-admins-ops'));
  await submit(page).click();

  const args = (await rpcReq).postDataJSON();
  expect(args).toMatchObject({
    p_header_id: null,
    p_worker_id: IDS.worker,
    p_client: CLIENT_NAME,
    p_project: SITE_NAME,
    p_role: 'General Labourer',
    p_status: 'pending',
    p_comments: 'Traffic control set-up and pack-down',
  });
  expect(args.p_lines).toHaveLength(1);
  const line = args.p_lines[0];
  expect(line).toMatchObject({ date: TODAY, shift_type: 'Day', total_hours: 13, total_break_hours: 0 });
  expect(Date.parse(line.end_time) - Date.parse(line.start_time)).toBe(13 * 3600 * 1000);

  expect((await alertReq).postDataJSON()).toEqual({ kind: 'fatigue_flagged', id: IDS.savedHeader });

  await expect(page.getByText('Daily timesheet submitted')).toBeVisible();
  // The post-save patch carries the answer, the master-data ids and the flag.
  const patch = mock.calls(`/rest/v1/timesheet_headers?id=eq.${IDS.savedHeader}`, 'PATCH');
  expect(patch).toHaveLength(1);
  expect(patch[0].body).toMatchObject({ finished_early: false, finished_early_reason: null, client_id: IDS.client, site_id: IDS.site });
  expect(patch[0].body.fatigue_flags).toEqual([expect.objectContaining({ type: 'long_shift', date: TODAY })]);
});

test('offline: submit parks the sheet, "Send now" replays it once back online', async ({ page, mock, guard }) => {
  // Requests made while offline fail in the browser log; that is the point.
  guard.allowConsole(/ERR_INTERNET_DISCONNECTED/);
  const date = noTake5Day();
  await openNewTimesheet(page, mock);
  await fillShift(page, { date, start: '07:00', end: '15:00', tasks: 'Line marking crew' });
  await finishedEarly(page, 'No').check();

  await mock.setOffline(true);
  await submit(page).click();
  await expect(page.getByText('Saved on your phone — it will send when you are back online.')).toBeVisible();
  const banner = page.locator('[data-area="offline timesheet queue"]');
  await expect(banner).toContainText('1 timesheet waiting to send');
  expect(mock.calls(RPC_PATH).filter(c => c.status !== 0)).toHaveLength(0);

  const queued = await page.evaluate(() => JSON.parse(window.localStorage.getItem('cbd_ts_queue') || '[]'));
  expect(queued).toHaveLength(1);
  expect(queued[0].payload.rpcArgs).toMatchObject({ p_worker_id: IDS.worker, p_client: CLIENT_NAME });
  expect(queued[0].payload.rpcArgs.p_lines[0]).toMatchObject({ date, total_hours: 8 });

  // Back online, but the browser's `online` event is swallowed (what iOS often
  // does after a tunnel) so the banner's button is what sends it.
  await mock.swallowOnlineEvent(true);
  await mock.setOffline(false);
  await expect(banner).toContainText('1 timesheet waiting to send'); // nothing auto-sent
  const rpcReq = page.waitForRequest(r => r.url().includes(RPC_PATH) && r.method() === 'POST');
  await banner.getByRole('button', { name: 'Send now' }).click();
  expect((await rpcReq).postDataJSON()).toEqual(queued[0].payload.rpcArgs);

  await expect(banner).toHaveCount(0);
  await expect(page.getByText(/^Sent: /)).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(window.localStorage.getItem('cbd_ts_queue') || '[]'))).toHaveLength(0);
});

// KNOWN GAP (found 2026-10-19 while writing the test above): on a Tue/Thu the
// form checks the take5 table BEFORE saving. Offline that read fails, the
// result is treated as "no Take 5", and the sheet is refused with "A Take 5 is
// required…" instead of being parked — even when the Take 5 was done. Remove
// Fixed 2026-10-19: DailyTimesheetForm skips the gate when the read cannot be made.
test('offline on a Take 5 day (Tue/Thu): the sheet is still parked', async ({ page, mock, guard }) => {
  guard.allowConsole(/ERR_INTERNET_DISCONNECTED/);
  await openNewTimesheet(page, mock);
  await fillShift(page, { date: TAKE5_DAY, start: '07:00', end: '15:00', tasks: 'Line marking crew' });
  await finishedEarly(page, 'No').check();
  await mock.setOffline(true);
  await submit(page).click();
  await expect(page.locator('[data-area="offline timesheet queue"]')).toContainText('1 timesheet waiting to send');
});
