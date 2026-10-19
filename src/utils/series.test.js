import { seriesDates, weekdayIndex, mondayOf, dayDiff } from './series';

test('weekdayIndex / mondayOf', () => {
  expect(weekdayIndex('2026-10-19')).toBe(0);   // Monday
  expect(weekdayIndex('2026-10-25')).toBe(6);   // Sunday
  expect(mondayOf('2026-10-22')).toBe('2026-10-19');
  expect(dayDiff('2026-10-19', '2026-10-21')).toBe(2);
});

test('seriesDates: every week on the start weekday', () => {
  expect(seriesDates('2026-10-21', 3, [2])).toEqual(['2026-10-21', '2026-10-28', '2026-11-04']);
});

test('seriesDates: several weekdays, drops days before the start date', () => {
  // Start Wednesday, Mon+Wed for 2 weeks → Mon of week 1 is skipped
  expect(seriesDates('2026-10-21', 2, [0, 2])).toEqual(['2026-10-21', '2026-10-26', '2026-10-28']);
});

test('seriesDates: caps at 12 weeks and tolerates bad input', () => {
  expect(seriesDates('2026-10-19', 99, [0])).toHaveLength(12);
  expect(seriesDates('', 4, [0])).toEqual([]);
  expect(seriesDates('2026-10-19', 4, [])).toEqual([]);
});
