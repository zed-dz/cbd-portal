import { ticketMatches, requiredTicketsFor, ticketGaps, certsByWorker } from './ticketCheck';

const rules = [
  { role_name: '*', ticket_name: 'White Card' },
  { role_name: 'Operator - Excavator', ticket_name: 'Excavator ticket' },
  { role_name: 'Operator - Excavator', ticket_name: 'white card' },       // duplicate of the wildcard, different case
  { role_name: 'Operator - Dozer', ticket_name: 'Dozer ticket' },
  { role_name: 'Operator - Dozer', ticket_name: 'Old rule', archived_at: '2026-01-01' },
];

test('ticketMatches is loose and case-insensitive', () => {
  expect(ticketMatches('White Card CPCCWHS1001', 'White Card')).toBe(true);
  expect(ticketMatches('Excavator (LE)', 'Excavator ticket')).toBe(true);
  expect(ticketMatches('EXCAVATOR', 'Excavator ticket')).toBe(true);
  expect(ticketMatches('Bulldozer', 'Dozer ticket')).toBe(false);
  expect(ticketMatches('', 'White Card')).toBe(false);
});

test('requiredTicketsFor merges wildcard + role and ignores archived', () => {
  expect(requiredTicketsFor(rules, '')).toEqual([]);
  expect(requiredTicketsFor(rules, 'Operator - Excavator').map(r => r.ticket_name)).toEqual(['White Card', 'Excavator ticket']);
  expect(requiredTicketsFor(rules, 'operator - dozer').map(r => r.ticket_name)).toEqual(['White Card', 'Dozer ticket']);
  expect(requiredTicketsFor(rules, 'General Labourer').map(r => r.ticket_name)).toEqual(['White Card']);
});

test('ticketGaps reports missing and expired, no-expiry counts as valid', () => {
  const req = requiredTicketsFor(rules, 'Operator - Excavator');
  const today = '2026-10-19';
  expect(ticketGaps([], req, today)).toEqual([
    { ticket: 'White Card', state: 'missing' },
    { ticket: 'Excavator ticket', state: 'missing' },
  ]);
  const certs = [{ name: 'White Card', expiry: null }, { name: 'Excavator (LE)', expiry: '2026-10-19' }];
  expect(ticketGaps(certs, req, today)).toEqual([{ ticket: 'Excavator ticket', state: 'expired', expiry: '2026-10-19' }]);
  const ok = [{ name: 'White Card', expiry: null }, { name: 'Excavator (LE)', expiry: '2027-01-01' }];
  expect(ticketGaps(ok, req, today)).toEqual([]);
});

test('certsByWorker flattens both tables', () => {
  const m = certsByWorker(
    [{ worker_id: 'a', cert_name: 'White Card', expiry: null }],
    [{ worker_id: 'a', name: 'Excavator', expiry_date: '2027-01-01' }, { worker_id: 'b', name: 'Dozer', expiry_date: null }],
  );
  expect(m.a).toHaveLength(2);
  expect(m.b).toEqual([{ name: 'Dozer', expiry: null }]);
});
