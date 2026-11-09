// Add worker from photos — pure mapping from the worker-intake function's JSON
// to what the Add Worker form understands. No React, no network: easy to test.
//
// The function returns { fields, confidence, tickets, warnings, via, images }.
// Here that becomes:
//   formPatch — keys that exist on the Add Worker `form` state
//   profile   — extra workers columns the form does not show (DOB, licence,
//               emergency contact…); merged into the insert payload on Save
//   tickets   — rows for the certifications table, each with keep=true and the
//               index of the photo it was read from (so Save can attach it)
//   checks    — the yellow "Check these" list: warnings + low-confidence fields

export const CONFIDENCE_FLOOR = 0.7;

// workers columns the office may insert (all in WORKER_SAFE_COLS; verified
// against the column grants 2026-11-09).
export const PROFILE_FIELDS = [
  ['date_of_birth',          'Date of birth',       'date'],
  ['gender',                 'Gender',              'text'],
  ['alternate_phone',        'Other phone',         'text'],
  ['postal_address',         'Postal address',      'text'],
  ['drivers_licence_number', 'Driver licence no.',  'text'],
  ['drivers_licence_expiry', 'Licence expiry',      'date'],
  ['citizenship_status',     'Citizenship / visa',  'text'],
  ['visa_subclass',          'Visa subclass',       'text'],
  ['visa_expiry',            'Visa expiry',         'date'],
  ['emergency_name',         'Emergency contact',   'text'],
  ['emergency_relationship', 'Relationship',        'text'],
  ['emergency_phone',        'Emergency phone',     'text'],
  ['emergency_phone_alt',    'Emergency phone 2',   'text'],
];

const FIELD_LABELS = {
  name: 'Full name', preferred_name: 'Preferred name', email: 'Email', mobile: 'Mobile',
  address: 'Address', drivers_licence_class: 'Licence class', licence_conditions: 'Licence conditions',
  usi: 'USI', white_card_number: 'White card number', white_card_issuer: 'White card issuer',
  job_title_hint: 'Job title',
  ...Object.fromEntries(PROFILE_FIELDS.map(([k, label]) => [k, label])),
};

const isoDate = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : '');
const clean = (v) => (v == null ? '' : String(v).trim());

export function mapIntakeToForm(result, { jobTitles = [] } = {}) {
  const f = (result && result.fields) || {};
  const conf = (result && result.confidence) || {};

  // Job title: only pre-fill when the hint is one the portal already knows,
  // otherwise it sits in "Check these" for the admin to pick.
  const hint = clean(f.job_title_hint);
  const knownTitle = jobTitles.find((t) => t.toLowerCase() === hint.toLowerCase()) || '';

  const tickets = [];
  (Array.isArray(result?.tickets) ? result.tickets : []).forEach((t, i) => {
    const name = clean(t.name);
    if (!name) return;
    tickets.push({
      key: `t${i}`,
      keep: true,
      cert_name: name,
      issuer: clean(t.issuer),
      expiry: isoDate(t.expiry),
      cert_number: clean(t.number),
      class_or_units: clean(t.class_or_units),
      source_image_index: Number.isInteger(t.source_image_index) ? t.source_image_index : null,
      confidence: typeof t.confidence === 'number' ? t.confidence : 0.6,
    });
  });

  // The driver licence is kept as an expiry-tracked row too (the Licence Agent
  // page is the portal's only place for a licence document with an expiry).
  const licNo = clean(f.drivers_licence_number);
  const licExp = isoDate(f.drivers_licence_expiry);
  if (licNo || licExp) {
    const cls = clean(f.drivers_licence_class);
    const idx = parseInt(f.drivers_licence_image_index, 10);
    tickets.push({
      key: 'licence',
      keep: true,
      cert_name: cls ? `Driver Licence (Class ${cls})` : 'Driver Licence',
      issuer: 'Driver licence',
      expiry: licExp,
      cert_number: licNo,
      class_or_units: clean(f.licence_conditions) ? `Conditions: ${clean(f.licence_conditions)}` : '',
      source_image_index: Number.isInteger(idx) ? idx : null,
      confidence: Math.min(conf.drivers_licence_number ?? 1, conf.drivers_licence_expiry ?? 1),
      isLicence: true,
    });
  }

  const formPatch = {
    name: clean(f.name),
    email: clean(f.email).toLowerCase(),
    mobile: clean(f.mobile),
    address: clean(f.address),
    job_title: knownTitle,
    // Quick-licences free text: ticket names, short, deduped.
    licences: [...new Set(tickets.map((t) => t.cert_name.replace(/\s*\(.*\)\s*$/, '').trim()).filter(Boolean))].join(', '),
  };

  const profile = {};
  for (const [k, , type] of PROFILE_FIELDS) {
    const v = type === 'date' ? isoDate(f[k]) : clean(f[k]);
    profile[k] = v;
  }

  // Check list: every warning, then every read field below the confidence floor.
  const checks = (Array.isArray(result?.warnings) ? result.warnings : []).map((w) => ({ kind: 'warning', text: String(w) }));
  Object.keys(FIELD_LABELS).forEach((k) => {
    const v = clean(f[k]);
    if (!v) return;
    const c = typeof conf[k] === 'number' ? conf[k] : 0;
    if (c < CONFIDENCE_FLOOR) checks.push({ kind: 'field', field: k, text: `${FIELD_LABELS[k]}: "${v}" — read with low confidence (${Math.round(c * 100)}%)` });
  });
  if (hint && !knownTitle) checks.push({ kind: 'field', field: 'job_title', text: `Job title suggested: "${hint}" — pick the matching role` });
  tickets.forEach((t) => {
    if (t.confidence < CONFIDENCE_FLOOR) checks.push({ kind: 'ticket', text: `Ticket "${t.cert_name}" — read with low confidence (${Math.round(t.confidence * 100)}%)` });
  });

  return { formPatch, profile, tickets, checks, via: result?.via || '', images: result?.images || 0 };
}

// Rows for the certifications table from the ticked tickets.
export function ticketRows(tickets, workerId) {
  return tickets.filter((t) => t.keep && t.cert_name.trim()).map((t) => ({
    worker_id: workerId,
    cert_name: t.cert_name.trim(),
    issuer: t.issuer.trim() || null,
    expiry: t.expiry || null,
    cert_number: t.cert_number.trim() || null,
    doc_url: t.doc_url || null,
  }));
}

// Non-empty profile values only, dates as ISO or null, so a blank never
// overwrites a column with ''.
export function profilePayload(profile) {
  const out = {};
  for (const [k, , type] of PROFILE_FIELDS) {
    const v = clean(profile?.[k]);
    if (!v) continue;
    if (type === 'date' && !isoDate(v)) continue;
    out[k] = v;
  }
  return out;
}
