import { checkFatigue, weekBounds, shiftFromLine, fatigueKey } from './fatigue';

const line = (date, start, end, brk = 0, total) => ({ date, start_time: start, end_time: end, total_break_hours: brk, total_hours: total });

describe('weekBounds', () => {
  test('Monday to Sunday around a mid-week date', () => {
    expect(weekBounds('2026-10-21')).toEqual({ from: '2026-10-19', to: '2026-10-25' }); // Wed
  });
  test('Sunday belongs to the week that started the Monday before', () => {
    expect(weekBounds('2026-10-25')).toEqual({ from: '2026-10-19', to: '2026-10-25' });
  });
  test('Monday is its own week start', () => {
    expect(weekBounds('2026-10-19')).toEqual({ from: '2026-10-19', to: '2026-10-25' });
  });
});

describe('shiftFromLine', () => {
  test('overnight end rolls to the next day', () => {
    const s = shiftFromLine(line('2026-10-20', '18:00', '04:00', 0.5));
    expect(s.endMs - s.startMs).toBe(10 * 3600000);
    expect(s.hours).toBe(9.5);
  });
  test('prefers the line total_hours when present', () => {
    expect(shiftFromLine(line('2026-10-20', '07:00', '15:00', 0.5, 7.5)).hours).toBe(7.5);
  });
  test('missing times give null', () => {
    expect(shiftFromLine({ date: '2026-10-20', start_time: '', end_time: '16:00' })).toBeNull();
  });
});

describe('checkFatigue', () => {
  test('a normal day raises nothing', () => {
    const r = checkFatigue({ lines: [line('2026-10-20', '07:00', '15:30', 0.5)] });
    expect(r.breaches).toEqual([]);
    expect(r.weekHours).toBe(8);
  });

  test('single shift over 12h is flagged', () => {
    const r = checkFatigue({ lines: [line('2026-10-20', '06:00', '19:00', 0.5)] });
    expect(r.breaches.map(b => b.type)).toEqual(['long_shift']);
    expect(r.breaches[0].text).toMatch(/12\.5h in one shift/);
  });

  test('exactly 12h is not a breach', () => {
    const r = checkFatigue({ lines: [line('2026-10-20', '06:00', '18:00', 0)] });
    expect(r.breaches).toEqual([]);
  });

  test('short rest against the previous saved shift', () => {
    const prevEnd = Date.UTC(2026, 9, 19, 23, 0); // finished 23:00 the night before
    const r = checkFatigue({ lines: [line('2026-10-20', '06:00', '14:00', 0)], previousEndMs: prevEnd });
    expect(r.breaches.map(b => b.type)).toEqual(['short_rest']);
    expect(r.breaches[0].text).toMatch(/only 7h rest/);
  });

  test('10h rest exactly is fine', () => {
    const prevEnd = Date.UTC(2026, 9, 19, 20, 0);
    const r = checkFatigue({ lines: [line('2026-10-20', '06:00', '14:00', 0)], previousEndMs: prevEnd });
    expect(r.breaches).toEqual([]);
  });

  test('short rest between two lines on the same sheet', () => {
    const r = checkFatigue({ lines: [
      line('2026-10-21', '04:00', '10:00', 0),   // out of order on purpose
      line('2026-10-20', '14:00', '22:00', 0),
    ] });
    expect(r.breaches.map(b => b.type)).toEqual(['short_rest']);
    expect(r.breaches[0].date).toBe('2026-10-21');
  });

  test('weekly total over 60h including other saved lines', () => {
    const r = checkFatigue({ lines: [line('2026-10-23', '07:00', '17:00', 0)], otherWeekHours: 52 });
    expect(r.weekHours).toBe(62);
    expect(r.breaches.map(b => b.type)).toEqual(['week_total']);
  });

  test('60h exactly is not a breach', () => {
    const r = checkFatigue({ lines: [line('2026-10-23', '07:00', '17:00', 0)], otherWeekHours: 50 });
    expect(r.breaches).toEqual([]);
  });

  test('all three breaches can stack', () => {
    const prevEnd = Date.UTC(2026, 9, 20, 2, 0);
    const r = checkFatigue({ lines: [line('2026-10-20', '05:00', '19:00', 0.5)], previousEndMs: prevEnd, otherWeekHours: 50 });
    expect(r.breaches.map(b => b.type).sort()).toEqual(['long_shift', 'short_rest', 'week_total']);
  });

  test('a custom instant resolver is honoured', () => {
    const offset = 10 * 3600000; // pretend every wall-clock is UTC+10
    const toInstant = (d, t) => {
      const [y, m, dd] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number);
      return Date.UTC(y, m - 1, dd, h, mi) - offset;
    };
    const prevEnd = Date.UTC(2026, 9, 19, 23, 0) - offset;
    const r = checkFatigue({ lines: [line('2026-10-20', '06:00', '14:00', 0)], previousEndMs: prevEnd, toInstant });
    expect(r.breaches.map(b => b.type)).toEqual(['short_rest']);
  });

  test('fatigueKey is stable and order-aware', () => {
    const r = checkFatigue({ lines: [line('2026-10-20', '06:00', '19:00', 0.5)] });
    expect(fatigueKey(r.breaches)).toBe('long_shift|2026-10-20');
    expect(fatigueKey([])).toBe('');
  });
});
