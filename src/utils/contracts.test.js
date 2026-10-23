import { fillTemplate, placeholdersIn, knownValues, pickTemplate, labelFor } from './contracts';

const worker = { name: 'Sam Taylor', email: 's@x.com', mobile: '0400 000 001', job_title: 'Labourer', worker_type: 'casual', pay_rate_a: 35, casual_loading_pct: 25 };

describe('contract templates', () => {
  test('lists placeholders once, in order', () => {
    expect(placeholdersIn('Hi {{worker_name}}, rate {{pay_rate}}, {{ Start_Date }} and {{worker_name}} again')).toEqual(['worker_name', 'pay_rate', 'start_date']);
  });

  test('fills known values and reports what the office must type', () => {
    const v = knownValues(worker, { name: 'Chris' });
    const { text, missing, used } = fillTemplate('{{worker_name}} starts {{start_date}} at ${{pay_rate}}/h ({{casual_loading}}). Sent by {{sender_name}}.', v);
    expect(text).toBe('Sam Taylor starts {{start_date}} at $35.00/h (25%). Sent by Chris.');
    expect(missing).toEqual(['start_date']);
    expect(used.pay_rate).toBe('35.00');
  });

  test('typed specifics fill the gaps and nothing is missing', () => {
    const v = { ...knownValues(worker, { name: 'Chris' }), start_date: '3 November 2026' };
    const r = fillTemplate('Start {{start_date}}', v);
    expect(r.text).toBe('Start 3 November 2026'); expect(r.missing).toEqual([]);
  });

  test('blank known values count as missing (no silent empty contract)', () => {
    const r = fillTemplate('ABN {{abn}}', knownValues({ ...worker, subcontractor_abn: '' }, { name: 'Chris' }));
    expect(r.missing).toEqual(['abn']);
  });

  test('picks the live default for the type, else the default for any', () => {
    const t = [
      { id: 1, worker_type: 'casual', is_default: true, archived_at: '2026-01-01' },
      { id: 2, worker_type: 'casual', is_default: true, archived_at: null },
      { id: 3, worker_type: null, is_default: true, archived_at: null },
    ];
    expect(pickTemplate(t, 'casual').id).toBe(2);
    expect(pickTemplate(t, 'full-time').id).toBe(3);
    expect(pickTemplate([t[0]], 'casual')).toBeNull();
  });

  test('labels: known ones are friendly, custom ones are prettified', () => {
    expect(labelFor('pay_rate')).toBe('Base hourly rate (rate A)');
    expect(labelFor('hours_per_week')).toBe('Hours per week');
  });
});
