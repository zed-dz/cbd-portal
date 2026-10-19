import {
  nextWeekStart, cleanWeekdays, weekdaysLabel, splitCrew, droppedNotice, templateDates,
  templateOccurrences, positionsFor, endDateFor, resolveClientSite, templateRowFromForm,
  formWeekdays, templateNames, templateJob,
} from './rosterTemplates';

const workers = [
  { id: 'a', name: 'Ann', app_status: 'Active' },
  { id: 'b', name: 'Bob', app_status: 'Active' },
  { id: 'c', name: 'Cal', app_status: 'Invite Sent' },
  { id: 'd', name: 'Dee', app_status: 'Active', archived_at: '2026-10-01T00:00:00Z' },
];

test('nextWeekStart: Monday of the following week, even on a Monday or Sunday', () => {
  expect(nextWeekStart('2026-10-19')).toBe('2026-10-26'); // Monday
  expect(nextWeekStart('2026-10-22')).toBe('2026-10-26'); // Thursday
  expect(nextWeekStart('2026-10-25')).toBe('2026-10-26'); // Sunday
  expect(nextWeekStart('2026-12-30')).toBe('2027-01-04'); // year roll
  expect(nextWeekStart('')).toBe('');
});

test('cleanWeekdays / weekdaysLabel', () => {
  expect(cleanWeekdays([4, 0, 4, 9, -1, '2'])).toEqual([0, 2, 4]);
  expect(weekdaysLabel([0, 1, 2, 3, 4])).toBe('Mon–Fri');
  expect(weekdaysLabel([0, 2])).toBe('Mon, Wed');
  expect(weekdaysLabel([])).toBe('no days set');
  expect(weekdaysLabel([0, 1, 2, 3, 4, 5, 6])).toBe('every day');
});

test('splitCrew drops archived, missing and not-Active workers', () => {
  const { keep, dropped } = splitCrew(['a', 'c', 'd', 'zzz', 'b', 'a'], workers);
  expect(keep).toEqual(['a', 'b']);
  expect(dropped).toEqual([
    { id: 'c', name: 'Cal', reason: 'Invite Sent' },
    { id: 'd', name: 'Dee', reason: 'archived' },
    { id: 'zzz', name: null, reason: 'archived' },
  ]);
  expect(droppedNotice(dropped)).toBe('Left out: Cal (Invite Sent), Dee (archived), 1 archived worker.');
  expect(droppedNotice([])).toBe('');
});

test('templateDates: weekdays mapped onto the given week', () => {
  const t = { weekdays: [4, 0, 2] };
  expect(templateDates(t, '2026-10-26')).toEqual(['2026-10-26', '2026-10-28', '2026-10-30']);
  // any day of the week snaps to its Monday
  expect(templateDates(t, '2026-10-29')).toEqual(['2026-10-26', '2026-10-28', '2026-10-30']);
  expect(templateDates({ weekdays: [6] }, '2026-10-26')).toEqual(['2026-11-01']);
  expect(templateDates({ weekdays: [] }, '2026-10-26')).toEqual([]);
});

test('templateOccurrences: one per active worker per day, inactive dropped', () => {
  const t = { weekdays: [0, 1], worker_ids: ['a', 'c', 'b'] };
  expect(templateOccurrences(t, '2026-10-26', workers)).toEqual([
    { date: '2026-10-26', worker_id: 'a' },
    { date: '2026-10-26', worker_id: 'b' },
    { date: '2026-10-27', worker_id: 'a' },
    { date: '2026-10-27', worker_id: 'b' },
  ]);
  expect(templateOccurrences({ weekdays: [0], worker_ids: ['c', 'd'] }, '2026-10-26', workers)).toEqual([]);
});

test('positionsFor never exceeds the crew that is left', () => {
  expect(positionsFor({ positions: 2 }, 5)).toBe(2);
  expect(positionsFor({ positions: 4 }, 3)).toBe(3);
  expect(positionsFor({ positions: null }, 3)).toBe(3);
  expect(positionsFor({}, 0)).toBe(1);
});

test('endDateFor: multi-day jobs only', () => {
  expect(endDateFor('2026-10-26', 1)).toBeNull();
  expect(endDateFor('2026-10-26', 3)).toBe('2026-10-28');
  expect(endDateFor('2026-10-30', 4)).toBe('2026-11-02');
});

const clients = [{ id: 'c1', name: 'Acme' }, { id: 'c2', name: 'Acme' }, { id: 'c3', name: 'Bolt' }];
const sites = [
  { id: 's1', client_id: 'c2', name: 'North', address: '1 North Rd', map_link: 'https://maps.app.goo.gl/x' },
  { id: 's2', client_id: 'c3', name: 'Yard', address: null, map_link: null },
];

test('resolveClientSite: the site decides between same-named clients', () => {
  expect(resolveClientSite(clients, sites, 'Acme', 'North')).toEqual({ client_id: 'c2', site_id: 's1' });
  expect(resolveClientSite(clients, sites, 'Acme', '')).toEqual({ client_id: null, site_id: null });
  expect(resolveClientSite(clients, sites, 'Bolt', '')).toEqual({ client_id: 'c3', site_id: null });
});

test('templateRowFromForm captures ids + snapshots, crew, days, duration', () => {
  const form = {
    client: 'Acme', site: 'North', project: 'Stage 4', role: 'Traffic Controller',
    start_date: '2026-10-21', end_date: '2026-10-22', arrival_time: '06:30', notes: 'Bring PPE',
    site_supervisor: 'Sam', manager_phone: '0400', map_link: '',
  };
  const row = templateRowFromForm({
    name: '  North crew ', form, workerIds: ['a', 'b', 'a'], positions: '', weekdays: [2, 0], clients, sites, actorName: 'Chris',
  });
  expect(row).toEqual({
    name: 'North crew', client_id: 'c2', client_name_snapshot: 'Acme', site_id: 's1', site_name_snapshot: 'North',
    project: 'Stage 4', role: 'Traffic Controller', worker_ids: ['a', 'b'], positions: null, weekdays: [0, 2],
    arrival_time: '06:30', duration_days: 2, notes: 'Bring PPE', site_manager: 'Sam', manager_phone: '0400',
    map_url: null, created_by_name: 'Chris',
  });
  // fewer positions than crew is kept; a bad time is dropped
  const r2 = templateRowFromForm({ name: 'x', form: { ...form, arrival_time: '6', end_date: '' }, workerIds: ['a', 'b', 'c'], positions: '2', weekdays: [], clients, sites });
  expect(r2.positions).toBe(2);
  expect(r2.arrival_time).toBeNull();
  expect(r2.duration_days).toBe(1);
});

test('formWeekdays: Repeat days, else the start date weekday', () => {
  expect(formWeekdays({ mode: 'weekly', weekdays: [3, 1] }, '2026-10-19')).toEqual([1, 3]);
  expect(formWeekdays({ mode: 'none', weekdays: [3] }, '2026-10-21')).toEqual([2]);
  expect(formWeekdays({ mode: 'none' }, '')).toEqual([]);
});

test('templateNames / templateJob prefer the live names, fall back to snapshots', () => {
  const t = { client_id: 'c2', site_id: 's1', client_name_snapshot: 'Old Acme', site_name_snapshot: 'Old North', role: 'Dogman', map_url: null };
  expect(templateNames(t, clients, sites)).toMatchObject({ client: 'Acme', site: 'North' });
  expect(templateNames({ ...t, client_id: 'gone', site_id: 'gone' }, clients, sites)).toMatchObject({ client: 'Old Acme', site: 'Old North' });
  const job = templateJob(t, clients, sites);
  expect(job).toMatchObject({ client: 'Acme', site: 'North', client_id: 'c2', site_id: 's1', address: '1 North Rd', map_link: 'https://maps.app.goo.gl/x', status: 'pending', role: 'Dogman' });
});
