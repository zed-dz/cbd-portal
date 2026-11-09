// Small helpers for the Allocation Board (2026-11-09): NSW public holidays,
// planned hours per shift, a stable colour per client, CSV + print text,
// and the Sydney rain forecast (Open-Meteo, no key).

// NSW public holidays. Source: NSW Government gazetted dates. Easter 2026 =
// 5 Apr, 2027 = 28 Mar. NSW does not substitute Anzac Day when it falls on a
// weekend; Christmas/Boxing Day on a weekend add the following weekday(s).
export const NSW_HOLIDAYS = {
  '2026-01-01': "New Year's Day", '2026-01-26': 'Australia Day',
  '2026-04-03': 'Good Friday', '2026-04-04': 'Easter Saturday', '2026-04-05': 'Easter Sunday', '2026-04-06': 'Easter Monday',
  '2026-04-25': 'Anzac Day', '2026-06-08': "King's Birthday", '2026-10-05': 'Labour Day',
  '2026-12-25': 'Christmas Day', '2026-12-26': 'Boxing Day', '2026-12-28': 'Boxing Day (additional)',
  '2027-01-01': "New Year's Day", '2027-01-26': 'Australia Day',
  '2027-03-26': 'Good Friday', '2027-03-27': 'Easter Saturday', '2027-03-28': 'Easter Sunday', '2027-03-29': 'Easter Monday',
  '2027-04-25': 'Anzac Day', '2027-06-14': "King's Birthday", '2027-10-04': 'Labour Day',
  '2027-12-25': 'Christmas Day', '2027-12-26': 'Boxing Day', '2027-12-27': 'Christmas Day (additional)', '2027-12-28': 'Boxing Day (additional)',
};
export const nswHoliday = (iso) => NSW_HOLIDAYS[iso] || null;

// Planned hours a board cell stands for (payroll heads-up, not the timesheet).
export function plannedHours(a) {
  if (!a) return 0;
  const h = { day: 8, night: 8, '8hrs': 8, rain_4: 4, rain_8: 8, rain_unpaid: 0 }[a.shift || 'day'];
  const base = h == null ? 8 : h;
  return a.left_early ? Math.min(base, 4) : base;
}

// Same client, same colour, every week. Hue from the name; muted saturation.
export function clientColor(name) {
  const s = String(name || '');
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 62% 58%)`;
}

// Text for one cell: "Client · Site · Shift · ½" or the status label.
export function cellText(work, status, shiftLabel) {
  if (work && work.length) {
    return work.map(a => [a.client || a.site || 'Job', a.site && a.client ? a.site : null, a.role || null, shiftLabel(a.shift), a.left_early ? 'left early' : null].filter(Boolean).join(' · ')).join(' / ');
  }
  return status || '';
}

export function toCsv(rows) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return rows.map(r => r.map(esc).join(',')).join('\r\n');
}

export function downloadText(filename, text, mime = 'text/csv') {
  const blob = new Blob(['﻿' + text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
}

// Black-on-white week sheet for printing. Hours and names only — no money.
export function printWeekHtml({ title, dayHeads, groups, notes }) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const rows = groups.map(g => `<tr class="g"><td colspan="${dayHeads.length + 1}">${esc(g.label)} (${g.rows.length})</td></tr>` +
    g.rows.map(r => `<tr><td class="n">${esc(r.name)}<br><small>${esc(r.sub || '')}</small></td>${r.cells.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')).join('');
  const noteRows = notes.length ? `<h2>Notes for payroll</h2><ul>${notes.map(n => `<li><b>${esc(n.name)}</b> — ${esc(n.day)}: ${esc(n.text)}</li>`).join('')}</ul>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:12px/1.35 Arial,sans-serif;color:#000;margin:18px}h1{font-size:18px;margin:0 0 10px}h2{font-size:14px;margin:18px 0 6px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:4px 6px;vertical-align:top;font-size:11px}th{background:#eee;text-align:left}
tr.g td{background:#f6f6f6;font-weight:700;letter-spacing:.5px;text-transform:uppercase;font-size:10px}td.n{white-space:nowrap;font-weight:700}small{font-weight:400;color:#555}
@media print{body{margin:8mm}}</style></head><body><h1>${esc(title)}</h1>
<table><thead><tr><th>Worker</th>${dayHeads.map(d => `<th>${esc(d)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>${noteRows}
<script>window.onload=function(){window.print()}</script></body></html>`;
}

// Sydney daily rain chance for the given ISO dates (max probability, %).
// Returns {} on any failure so the board never waits on the weather.
export async function fetchRainChance(fromIso, toIso) {
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=-33.87&longitude=151.21&daily=precipitation_probability_max,precipitation_sum&timezone=Australia%2FSydney&start_date=${fromIso}&end_date=${toIso}`;
    const r = await fetch(u); if (!r.ok) return {};
    const j = await r.json();
    const out = {};
    (j.daily?.time || []).forEach((d, i) => { out[d] = { chance: j.daily.precipitation_probability_max?.[i] ?? null, mm: j.daily.precipitation_sum?.[i] ?? null }; });
    return out;
  } catch { return {}; }
}
