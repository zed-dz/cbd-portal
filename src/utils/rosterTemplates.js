// Saved roster templates — pure logic, kept out of the page so it can be
// unit-tested. A template is a named crew + job (table `roster_templates`):
// client/site ids with name snapshots, role, worker_ids, weekdays (0 = Mon …
// 6 = Sun), arrival time 'HH:MM', duration in days, supervisor fields.
import { mondayOf, addDays, dayDiff, weekdayIndex, WEEKDAY_NAMES } from './series';

// The Monday of NEXT week (the week after the one `todayISO` sits in). On a
// Monday that is still a week away — "next week" never means "today".
export function nextWeekStart(todayISO) {
  if (!todayISO) return '';
  return addDays(mondayOf(todayISO), 7);
}

// Clean weekday list: unique ints 0..6, sorted.
export function cleanWeekdays(weekdays) {
  return [...new Set((weekdays || []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
}

export function weekdaysLabel(weekdays) {
  const d = cleanWeekdays(weekdays);
  if (!d.length) return 'no days set';
  if (d.length === 5 && d.join(',') === '0,1,2,3,4') return 'Mon–Fri';
  if (d.length === 7) return 'every day';
  return d.map(i => WEEKDAY_NAMES[i]).join(', ');
}

// Split a template's crew into who can still be rostered and who drops out.
// `workers` = rows { id, name, app_status, archived_at }. A worker missing from
// the list (archived ones are not loaded) or not 'Active' is dropped — the
// office sees a small notice instead of a silent gap.
export function splitCrew(workerIds, workers) {
  const byId = new Map((workers || []).map(w => [w.id, w]));
  const keep = [];
  const dropped = [];
  const seen = new Set();
  for (const id of workerIds || []) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const w = byId.get(id);
    if (!w || w.archived_at) dropped.push({ id, name: w?.name || null, reason: 'archived' });
    else if ((w.app_status || '') !== 'Active') dropped.push({ id, name: w.name || null, reason: w.app_status || 'not active' });
    else keep.push(id);
  }
  return { keep, dropped };
}

export function droppedNotice(dropped) {
  if (!dropped?.length) return '';
  const named = dropped.filter(d => d.name).map(d => `${d.name} (${d.reason})`);
  const unnamed = dropped.length - named.length;
  const parts = [...named];
  if (unnamed) parts.push(`${unnamed} archived worker${unnamed === 1 ? '' : 's'}`);
  return `Left out: ${parts.join(', ')}.`;
}

// Dates the template covers in the week starting `weekStartISO` (any day of
// that week works — it is snapped to its Monday).
export function templateDates(template, weekStartISO) {
  if (!weekStartISO) return [];
  const mon = mondayOf(weekStartISO);
  return cleanWeekdays(template?.weekdays).map(d => addDays(mon, d));
}

// Template → list of { date, worker_id } occurrences for a given week, crew
// filtered to workers who are still active. Ordered by date, then crew order.
export function templateOccurrences(template, weekStartISO, workers) {
  const { keep } = splitCrew(template?.worker_ids, workers);
  const out = [];
  for (const date of templateDates(template, weekStartISO)) {
    for (const worker_id of keep) out.push({ date, worker_id });
  }
  return out;
}

// Positions per date for a run: the template's number, never more than the
// crew that is left (and at least 1).
export function positionsFor(template, crewSize) {
  const n = Math.max(1, crewSize || 0);
  const p = parseInt(template?.positions, 10);
  return Number.isFinite(p) && p >= 1 ? Math.min(p, n) : n;
}

// End date for an occurrence of a multi-day job; null for a single day.
export function endDateFor(dateISO, durationDays) {
  const d = parseInt(durationDays, 10) || 1;
  return d > 1 ? addDays(dateISO, d - 1) : null;
}

// Client/site names → ids, the same rule the Create Allocation save uses: the
// site decides the client when two clients share a name.
export function resolveClientSite(clients, sites, clientName, siteName) {
  const cs = (clients || []).filter(c => c.name === clientName);
  const site = (sites || []).find(s => cs.some(c => c.id === s.client_id) && s.name === siteName) || null;
  const client = site ? cs.find(c => c.id === site.client_id) : (cs.length === 1 ? cs[0] : null);
  return { client_id: client?.id || null, site_id: site?.id || null };
}

// The Create Allocation form → a roster_templates row (without created_by,
// which the database fills in).
export function templateRowFromForm({ name, form, workerIds, positions, weekdays, clients, sites, actorName }) {
  const ids = [...new Set(workerIds || [])];
  const { client_id, site_id } = resolveClientSite(clients, sites, form.client, form.site);
  const duration = form.start_date && form.end_date ? Math.max(0, dayDiff(form.start_date, form.end_date)) + 1 : 1;
  const p = parseInt(positions, 10);
  return {
    name: String(name || '').trim(),
    client_id,
    client_name_snapshot: form.client || null,
    site_id,
    site_name_snapshot: form.site || null,
    project: form.project || null,
    role: form.role || null,
    worker_ids: ids,
    positions: Number.isFinite(p) && p >= 1 && p < ids.length ? p : null,
    weekdays: cleanWeekdays(weekdays),
    arrival_time: /^\d{2}:\d{2}$/.test(form.arrival_time || '') ? form.arrival_time : null,
    duration_days: Math.min(31, duration),
    notes: form.notes || null,
    site_manager: form.site_supervisor || null,
    manager_phone: form.manager_phone || null,
    map_url: form.map_link || null,
    created_by_name: actorName || null,
  };
}

// Weekdays a Create form implies: the Repeat days when repeating weekly,
// otherwise the start date's own weekday.
export function formWeekdays(repeat, startISO) {
  if (repeat?.mode === 'weekly' && repeat.weekdays?.length) return cleanWeekdays(repeat.weekdays);
  return startISO ? [weekdayIndex(startISO)] : [];
}

// Current names for the ids (a renamed client shows its new name); the
// snapshot is the fallback when the master row is gone or archived.
export function templateNames(template, clients, sites) {
  const client = (clients || []).find(c => c.id === template?.client_id);
  const site = (sites || []).find(s => s.id === template?.site_id);
  return {
    client: client?.name || template?.client_name_snapshot || '',
    site: site?.name || template?.site_name_snapshot || '',
    siteRow: site || null,
  };
}

// Allocation fields shared by every occurrence of a template run (worker,
// dates and series are added per occurrence by the caller).
export function templateJob(template, clients, sites) {
  const { client, site, siteRow } = templateNames(template, clients, sites);
  return {
    role: template.role || null,
    client, site,
    client_id: template.client_id || null,
    site_id: template.site_id || null,
    project: template.project || '',
    address: siteRow?.address || '',
    site_manager: template.site_manager || '',
    manager_phone: template.manager_phone || '',
    status: 'pending',
    end_time: null,
    notes: template.notes || null,
    map_link: template.map_url || siteRow?.map_link || null,
  };
}
