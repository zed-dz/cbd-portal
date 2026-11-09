import { nswHoliday, plannedHours, clientColor, cellText, toCsv } from './boardExtras';

describe('boardExtras', () => {
  test('NSW public holidays: known dates, no substitute for a weekend Anzac Day', () => {
    expect(nswHoliday('2026-04-06')).toBe('Easter Monday');
    expect(nswHoliday('2026-12-28')).toMatch(/Boxing Day/);
    expect(nswHoliday('2027-04-26')).toBeNull();   // Anzac Day 2027 is a Sunday: NSW adds no Monday
    expect(nswHoliday('2026-11-10')).toBeNull();
  });
  test('planned hours per shift and left early', () => {
    expect(plannedHours({ shift: 'day' })).toBe(8);
    expect(plannedHours({ shift: null })).toBe(8);
    expect(plannedHours({ shift: 'rain_4' })).toBe(4);
    expect(plannedHours({ shift: 'rain_unpaid' })).toBe(0);
    expect(plannedHours({ shift: 'night', left_early: true })).toBe(4);
    expect(plannedHours(null)).toBe(0);
  });
  test('client colour is stable and valid hsl', () => {
    expect(clientColor('Mainland')).toBe(clientColor('Mainland'));
    expect(clientColor('Mainland')).not.toBe(clientColor('Wearn'));
    expect(clientColor('Mainland')).toMatch(/^hsl\(\d+ 62% 58%\)$/);
  });
  test('cell text and csv escaping', () => {
    const t = cellText([{ client: 'Mainland', site: 'Moorebank', role: 'Dozer', shift: 'rain_4', left_early: true }], null, s => (s === 'rain_4' ? 'Rain 4hrs' : ''));
    expect(t).toBe('Mainland · Moorebank · Dozer · Rain 4hrs · left early');
    expect(cellText([], 'SICK', () => '')).toBe('SICK');
    expect(toCsv([['a', 'b,c', 'say "hi"'], [1, null, 'x']])).toBe('a,"b,c","say ""hi"""\r\n1,,x');
  });
});
