// Ticket check for allocations — "does this worker hold the tickets this role
// needs?" One place for the matching rule so the Create Allocation modal and
// the Allocation Board agree.
//
// Rules live in `role_required_tickets` (role_name '*' = every role). A worker's
// tickets come from BOTH `certifications(cert_name, expiry)` and
// `worker_certificates(name, expiry_date)`, flattened to [{ name, expiry }].
//
// Matching is deliberately loose — ticket names are typed by hand on both
// sides. A cert matches a rule when (case-insensitive) one name contains the
// other, OR every keyword of the rule appears in the cert name (filler words
// like "ticket", "card", "licence" are ignored). "Excavator ticket" therefore
// matches "Excavator (LE)" and "White Card" matches "White Card CPCCWHS1001".

const STOP = new Set(['ticket', 'tickets', 'card', 'licence', 'license', 'certificate', 'cert', 'competency', 'and', 'or', 'the', 'a', 'of', 'for']);

export function ticketTokens(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t && !STOP.has(t));
}

export function ticketMatches(certName, requiredName) {
  const c = String(certName || '').trim().toLowerCase();
  const r = String(requiredName || '').trim().toLowerCase();
  if (!c || !r) return false;
  if (c.includes(r) || r.includes(c)) return true;
  const toks = ticketTokens(requiredName);
  if (!toks.length) return false;
  const have = new Set(ticketTokens(certName));
  return toks.every(t => have.has(t));
}

// Live rules that apply to `role` (wildcard '*' + exact role, de-duplicated by
// ticket name). No role → no rules: the check only runs once a role is chosen.
export function requiredTicketsFor(rules, role) {
  const r = String(role || '').trim().toLowerCase();
  if (!r) return [];
  const seen = new Set();
  const out = [];
  for (const x of rules || []) {
    if (x.archived_at || x.required === false) continue;
    const rn = String(x.role_name || '').trim();
    if (rn !== '*' && rn.toLowerCase() !== r) continue;
    const key = String(x.ticket_name || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out;
}

// certs: [{ name, expiry }] for one worker. A ticket with no expiry is valid
// (White Card never expires); expiry must be strictly after today.
// Returns [{ ticket, state: 'missing' | 'expired', expiry }].
export function ticketGaps(certs, required, todayISO) {
  const out = [];
  for (const req of required || []) {
    const hits = (certs || []).filter(c => ticketMatches(c.name, req.ticket_name));
    if (!hits.length) { out.push({ ticket: req.ticket_name, state: 'missing' }); continue; }
    const valid = hits.some(c => !c.expiry || String(c.expiry).slice(0, 10) > todayISO);
    if (!valid) {
      const latest = hits.map(c => String(c.expiry || '').slice(0, 10)).sort().pop();
      out.push({ ticket: req.ticket_name, state: 'expired', expiry: latest });
    }
  }
  return out;
}

export function gapLabel(g) {
  return `${g.state}: ${g.ticket}${g.state === 'expired' && g.expiry ? ` (${g.expiry})` : ''}`;
}

// Flatten the two cert tables into { worker_id → [{ name, expiry }] }.
export function certsByWorker(certRows, workerCertRows) {
  const m = {};
  (certRows || []).forEach(r => { (m[r.worker_id] = m[r.worker_id] || []).push({ name: r.cert_name, expiry: r.expiry }); });
  (workerCertRows || []).forEach(r => { (m[r.worker_id] = m[r.worker_id] || []).push({ name: r.name, expiry: r.expiry_date }); });
  return m;
}
