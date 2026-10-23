// Employment contracts from templates (2026-10-23).
// One place that fills a template's {{placeholders}} from a worker record and
// says what is still missing. Used by the Contracts page, the Add Worker
// auto-send, and the application approval.

export const PLACEHOLDER_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

// Placeholders the portal fills by itself. Anything else in a template is a
// "specific detail" the office types when sending.
export const KNOWN_FIELDS = [
  ['worker_name', 'Worker full name'], ['email', 'Email'], ['mobile', 'Mobile'], ['address', 'Residential address'],
  ['job_title', 'Job title / role'], ['worker_type', 'Worker type'], ['date_of_birth', 'Date of birth'],
  ['abn', 'ABN (subcontractors)'], ['pay_rate', 'Base hourly rate (rate A)'], ['casual_loading', 'Casual loading, e.g. 25%'],
  ['emergency_name', 'Emergency contact name'], ['emergency_phone', 'Emergency contact phone'],
  ['company_name', 'Company name'], ['sender_name', 'The admin sending it'], ['today', "Today's date"],
];
export const KNOWN_KEYS = new Set(KNOWN_FIELDS.map(([k]) => k));

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Australia/Sydney' });
};
const money = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? '' : Number(v).toFixed(2));

// Values the portal knows for this worker. Empty strings mean "unknown".
export function knownValues(worker, sender, company = {}) {
  const w = worker || {};
  const loading = w.worker_type === 'casual' ? `${Number(w.casual_loading_pct ?? 25)}%` : '';
  return {
    worker_name: w.name || '', email: w.email || '', mobile: w.mobile || '', address: w.address || '',
    job_title: w.job_title || '', worker_type: w.worker_type || '', date_of_birth: fmtDate(w.date_of_birth),
    abn: w.subcontractor_abn || '', pay_rate: money(w.pay_rate_a ?? w.pay_rate_regular), casual_loading: loading,
    emergency_name: w.emergency_name || '', emergency_phone: w.emergency_phone || '',
    company_name: company.name || 'CBD Plant & Labour Pty Ltd', sender_name: (sender && sender.name) || '',
    today: fmtDate(new Date().toISOString()),
  };
}

// Every placeholder a template uses, in order of first appearance, without repeats.
export function placeholdersIn(body) {
  const seen = new Set(); const out = [];
  for (const m of String(body || '').matchAll(PLACEHOLDER_RE)) { const k = m[1].toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(k); } }
  return out;
}

// Fill a template. `values` = known values + anything the office typed.
// Returns { text, missing, used }: `missing` lists placeholders with no value.
export function fillTemplate(body, values) {
  const v = values || {}; const missing = []; const used = {};
  const text = String(body || '').replace(PLACEHOLDER_RE, (_, raw) => {
    const k = raw.toLowerCase(); const val = v[k];
    if (val == null || String(val).trim() === '') { if (!missing.includes(k)) missing.push(k); return `{{${k}}}`; }
    used[k] = String(val).trim(); return used[k];
  });
  return { text, missing, used };
}

// Plain label for a placeholder the office must type.
export function labelFor(key) {
  const known = KNOWN_FIELDS.find(([k]) => k === key);
  return known ? known[1] : key.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

// The template to use for a worker: the live default for their type, else the live default for "any".
export function pickTemplate(templates, workerType) {
  const live = (templates || []).filter(t => !t.archived_at);
  return live.find(t => t.is_default && t.worker_type === workerType) || live.find(t => t.is_default && !t.worker_type) || null;
}

// Short message that goes with the contract (text + email through notify-worker).
export function sendMessage(workerFirstName, companyName, portalUrl) {
  return `Hi ${workerFirstName || 'there'}, your employment contract from ${companyName} is ready. Open the app, go to Documents, read it and sign. ${portalUrl}`;
}
