// Management report pack — one printable HTML page for a month (admin-only
// internal pack: cash, P&L, margin by client, debtors, BAS estimate,
// exceptions, compliance dates). window.print → PDF. Pure: builds a string.

import { fmtMoney, monthLabel, monthBounds, daysOverdue } from './books';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => esc(fmtMoney(n));
const pct = (n) => `${(Number(n) || 0).toFixed(1)}%`;
const date = (s) => { if (!s) return '—'; const [y, m, d] = String(s).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };

export function buildReportPackHTML({ brand, month, today, pnl, margin, debtors, bas, quarter, exceptions, obligations, forecast, close, cashMonths }) {
  const { from, to } = monthBounds(month);
  const mLabel = monthLabel(month);
  const cm = (cashMonths || []).find((m) => String(m.month).slice(0, 7) === month) || {};
  const groups = (pnl?.groups || []);
  const clientRows = (margin?.client || []).slice(0, 15);
  const openDebtors = (debtors || []).slice().sort((a, b) => daysOverdue(b.due_date, today) - daysOverdue(a.due_date, today)).slice(0, 20);
  const exCounts = (exceptions || []).reduce((a, e) => { a[e.flag] = (a[e.flag] || 0) + 1; return a; }, {});
  const row = (cells, cls = '') => `<tr class="${cls}">${cells.map((c, i) => `<td class="${i === 0 ? '' : 'n'}">${c}</td>`).join('')}</tr>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(brand)} · Management pack · ${esc(mLabel)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font: 11.5px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 13px; margin: 18px 0 6px; text-transform: uppercase; letter-spacing: 1px; color: #444; border-bottom: 1px solid #ccc; padding-bottom: 3px; }
  .sub { color: #666; font-size: 11px; }
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 10px 0; }
  .tile { border: 1px solid #ddd; border-radius: 6px; padding: 8px 10px; } .tile .k { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: .8px; } .tile .v { font: 600 16px/1.2 ui-monospace, Menlo, Consolas, monospace; margin-top: 3px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; } td, th { padding: 4px 6px; border-bottom: 1px solid #eee; vertical-align: top; } th { text-align: left; font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: .8px; }
  td.n, th.n { text-align: right; font-family: ui-monospace, Menlo, Consolas, monospace; white-space: nowrap; }
  tr.tot td { font-weight: 700; border-top: 2px solid #999; }
  .neg { color: #b91c1c; } .ok { color: #15803d; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .foot { margin-top: 18px; color: #888; font-size: 10px; border-top: 1px solid #ddd; padding-top: 6px; }
  @media print { .noprint { display: none; } }
</style></head><body>
<div class="noprint" style="margin-bottom:10px"><button onclick="window.print()" style="padding:8px 14px;font-size:13px;cursor:pointer">Print / save as PDF</button></div>
<h1>${esc(brand)} — Management pack</h1>
<div class="sub">${esc(mLabel)} (${date(from)} → ${date(to)}) · prepared ${date(today)} · cash basis · internal, not for clients</div>

<div class="tiles">
  <div class="tile"><div class="k">Cash in · ${esc(mLabel)}</div><div class="v">${money(cm.cash_in || 0)}</div></div>
  <div class="tile"><div class="k">Cash out · ${esc(mLabel)}</div><div class="v">${money(cm.cash_out || 0)}</div></div>
  <div class="tile"><div class="k">Net P&amp;L · ${esc(mLabel)}</div><div class="v ${(pnl?.net?.[month] || 0) < 0 ? 'neg' : ''}">${money(pnl?.net?.[month] || 0)}</div></div>
  <div class="tile"><div class="k">Gross margin</div><div class="v">${margin?.totals ? `${money(margin.totals.margin)} · ${pct(margin.totals.margin_pct)}` : '—'}</div></div>
</div>

<h2>Profit &amp; loss · ${esc(mLabel)}</h2>
<table><thead><tr><th>Group / account</th><th class="n">${esc(mLabel)}</th><th class="n">${esc(pnl?.months?.length || 0)}-month total</th></tr></thead><tbody>
${groups.map((G) => row([`<b>${esc(G.label)}</b>`, money(G.byMonth[month] || 0), money(G.total)]) + G.accounts.slice(0, 8).map((A) => row([`&nbsp;&nbsp;${esc(A.code)} ${esc(A.name)}`, money(A.byMonth[month] || 0), money(A.total)])).join('')).join('')}
${row(['Net', money(pnl?.net?.[month] || 0), money(pnl?.net_total || 0)], 'tot')}
</tbody></table>

<h2>Gross margin by client · ${esc(margin?.period ? `${date(margin.period.from)} → ${date(margin.period.to)}` : '')}</h2>
<table><thead><tr><th>Client</th><th class="n">Shifts</th><th class="n">Hours</th><th class="n">Billed</th><th class="n">Pay</th><th class="n">Margin</th><th class="n">%</th></tr></thead><tbody>
${clientRows.map((c) => row([esc(c.label), c.shifts, c.hours.toFixed(1), money(c.charge), money(c.pay), `<span class="${c.margin < 0 ? 'neg' : ''}">${money(c.margin)}</span>`, pct(c.margin_pct)])).join('') || row(['No approved timesheets in range', '', '', '', '', '', ''])}
${margin?.totals ? row(['Total', margin.totals.shifts, margin.totals.hours.toFixed(1), money(margin.totals.charge), money(margin.totals.pay), money(margin.totals.margin), pct(margin.totals.margin_pct)], 'tot') : ''}
</tbody></table>
${(margin?.leaks || []).length ? `<div class="sub" style="margin-top:4px">Leaks: ${margin.leaks.slice(0, 6).map((l) => `${esc(l.who)} (${esc(l.detail)})`).join(' · ')}</div>` : ''}

<div class="two">
<div>
<h2>Debtors · open sales invoices</h2>
<table><thead><tr><th>Client · invoice</th><th class="n">Due</th><th class="n">Late</th><th class="n">Owing</th></tr></thead><tbody>
${openDebtors.map((d) => { const late = daysOverdue(d.due_date, today); return row([`${esc(d.contact_name)}<br><span class="sub">${esc(d.number || '')}</span>`, date(d.due_date), late > 0 ? `<span class="neg">${late} d</span>` : '—', money(d.amount_due)]); }).join('') || row(['None', '', '', ''])}
${row(['Total', '', '', money((debtors || []).reduce((s, d) => s + (Number(d.amount_due) || 0), 0))], 'tot')}
</tbody></table>
</div>
<div>
<h2>BAS estimate · ${esc(quarter?.label || '')}</h2>
<table><tbody>
${row(['G1 total sales', money(bas?.g1)])}${row(['G11 non-capital purchases', money(bas?.g11)])}${row(['1A GST on sales', money(bas?.gst_1a)])}${row(['1B GST on purchases', money(bas?.gst_1b)])}
${row(['Net GST', money((Number(bas?.gst_1a) || 0) - (Number(bas?.gst_1b) || 0))], 'tot')}
</tbody></table>
<h2>Compliance dates</h2>
<table><tbody>
${(obligations || []).slice(0, 6).map((o) => row([esc(o.label), `${date(o.due)} · ${o.days_left} d${o.amount !== null && o.amount !== undefined ? ` · ${money(o.amount)} est.` : ''}`])).join('')}
</tbody></table>
<h2>Exceptions</h2>
<table><tbody>${Object.entries(exCounts).map(([k, v]) => row([esc(k.replace(/_/g, ' ')), v])).join('') || row(['None', ''])}</tbody></table>
<h2>Cash · next 13 weeks</h2>
<table><tbody>
${row(['Opening (today)', forecast?.opening === null || forecast?.opening === undefined ? '— (no bank balance typed)' : money(forecast.opening)])}
${row(['Expected in', money(forecast?.total_in || 0)])}${row(['Expected out', money(forecast?.total_out || 0)])}
${row(['Runway', forecast?.runway_week ? `<span class="neg">below zero week of ${date(forecast.runway_week)}</span>` : forecast?.opening === null || forecast?.opening === undefined ? '—' : '<span class="ok">13+ weeks</span>'])}
</tbody></table>
<h2>Month-end</h2>
<table><tbody>${row(['Status', close?.closed ? `Closed ${esc(close.closed_at ? close.closed_at.slice(0, 10) : '')} by ${esc(close.closed_by || '')}` : 'Open'])}${(close?.checklist?.items || []).map((i) => row([esc(i.label), i.count])).join('')}</tbody></table>
</div>
</div>
<div class="foot">Figures from the portal's synced copy of Xero (bank transactions, payments, invoices, chart of accounts) and approved timesheets. Not included: payroll journals, manual journals, transfers. PAYG and super amounts are estimates.</div>
</body></html>`;
}

export function openReportPack(html) {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.open(); w.document.write(html); w.document.close();
  return true;
}
