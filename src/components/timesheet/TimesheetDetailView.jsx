import { C, btnPrimary, btnSecondary } from '../../theme';
import { fmtDate, fmtDateTime } from '../../utils/dates';
import { dayFromDate } from '../../utils/payroll';
import { timesheetBadge } from '../ui/Badge';

const BRAND_DEFAULT = 'CBD Plant & Labour';

const fmtTime = (iso) => iso
  ? new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })
  : '—';

const lineRdo = (l) => parseFloat(l.rdo_hours) || 0;
const lineOT = (l) => l.overtime_hours != null
  ? (parseFloat(l.overtime_hours) || 0)
  : Math.max(0, (parseFloat(l.total_hours) || 0) - (parseFloat(l.regular_hours ?? l.total_hours) || 0) - lineRdo(l));

// A line is "adjusted" when an admin changed times away from what the worker
// originally submitted — surfaced so there's never a dispute about the original.
const isAdjusted = (l) => !!l.adjusted_at;

function sumBy(lines, fn) {
  return lines.reduce((s, l) => s + (fn(l) || 0), 0);
}

// Full, client-presentable view of one daily timesheet (header + line rows).
// Shows hours only — no pay or charge rates — so it's safe to hand to a client
// or to the worker. Print/Save-PDF opens a light print-friendly window.
//
// This is the screen a worker or client sees when ACCEPTING a timesheet, so by
// default it mirrors the printed PDF exactly: Start / Break / Finish / Total and
// nothing else. Normal, RDO, OT and Meal are payroll detail — we pay the worker
// differently from how we invoice the client, and showing the split here invited
// questions from both sides. Pass showPayDetail to bring the breakdown back for
// an admin-only context.
export function TimesheetDetailView({ header, lines = [], workerName, brand = BRAND_DEFAULT, onClose, onEdit, showPayDetail = false }) {
  const totalHours = sumBy(lines, l => parseFloat(l.total_hours) || 0);
  const totalReg   = sumBy(lines, l => parseFloat(l.regular_hours ?? l.total_hours) || 0);
  const totalRdo   = sumBy(lines, lineRdo);
  const totalOT    = sumBy(lines, lineOT);
  const totalMeal  = sumBy(lines, l => parseFloat(l.meal_allowance) || 0);
  const adjusted   = lines.filter(isAdjusted);

  const meta = [
    ['Worker', workerName || '—'],
    ['Client', header.client || '—'],
    ['Project', header.project || '—'],
    ['Role', header.role || '—'],
    ['Wet hire', header.wet_hire ? 'Yes' : 'No'],
    ['Submitted', fmtDateTime(header.created_at)],
  ];

  const th = { padding: '7px 8px', fontSize: 11, color: C.textMuted, textAlign: 'left', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: `1px solid ${C.border}` };
  const td = { padding: '7px 8px', fontSize: 13, color: C.text, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>{brand} — Daily Timesheet</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>{lines.length} shift{lines.length !== 1 ? 's' : ''} · {timesheetBadge(header.status)}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {onEdit && <button onClick={onEdit} style={btnSecondary}>✎ Edit / Adjust</button>}
          <button onClick={() => printTimesheet({ header, lines, workerName, brand })} style={btnPrimary}>🖨 Print / Save PDF</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
        {meta.map(([k, v]) => (
          <div key={k} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px' }}>
            <div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>{k}</div>
            <div style={{ fontSize: 13, color: C.text, fontWeight: 600 }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Date</th><th style={th}>Day</th><th style={th}>Shift</th>
              <th style={th}>Start</th><th style={th}>Break</th><th style={th}>Finish</th>
              <th style={th}>Total</th>
              {showPayDetail && (<><th style={th}>Normal</th><th style={th}>RDO</th><th style={th}>OT</th><th style={th}>Meal</th></>)}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id || i}>
                <td style={td}>{fmtDate(l.date)}{isAdjusted(l) && <span title={`Adjusted by ${l.adjusted_by}`} style={{ color: C.warning, marginLeft: 4 }}>✎</span>}</td>
                <td style={td}>{dayFromDate(l.date) || '—'}</td>
                <td style={td}>{l.shift_type || 'Day'}</td>
                <td style={td}>{fmtTime(l.start_time)}</td>
                <td style={td}>{l.total_break_hours ? `${l.total_break_hours}h` : (l.break_minutes ? `${l.break_minutes}m` : '—')}</td>
                <td style={td}>{fmtTime(l.end_time)}</td>
                <td style={{ ...td, fontWeight: 700 }}>{Number(l.total_hours || 0).toFixed(2)}</td>
                {showPayDetail && (<>
                  <td style={td}>{Number(l.regular_hours ?? l.total_hours ?? 0).toFixed(2)}</td>
                  <td style={{ ...td, color: lineRdo(l) > 0 ? C.success : C.textMuted }}>{lineRdo(l) > 0 ? lineRdo(l).toFixed(2) : '—'}</td>
                  <td style={{ ...td, color: lineOT(l) > 0 ? C.warning : C.textMuted }}>{lineOT(l) > 0 ? lineOT(l).toFixed(2) : '—'}</td>
                  <td style={td}>{(parseFloat(l.meal_allowance) || 0) > 0 ? `$${Number(l.meal_allowance).toFixed(2)}` : '—'}</td>
                </>)}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={6} style={{ ...td, color: C.textMuted, borderBottom: 'none' }}>Totals</td>
              <td style={{ ...td, fontWeight: 800, color: C.accent, borderBottom: 'none' }}>{totalHours.toFixed(2)}</td>
              {showPayDetail && (<>
                <td style={{ ...td, fontWeight: 700, borderBottom: 'none' }}>{totalReg.toFixed(2)}</td>
                <td style={{ ...td, fontWeight: 700, color: totalRdo > 0 ? C.success : C.textMuted, borderBottom: 'none' }}>{totalRdo > 0 ? totalRdo.toFixed(2) : '—'}</td>
                <td style={{ ...td, fontWeight: 700, color: totalOT > 0 ? C.warning : C.textMuted, borderBottom: 'none' }}>{totalOT > 0 ? totalOT.toFixed(2) : '—'}</td>
                <td style={{ ...td, borderBottom: 'none' }}>{totalMeal > 0 ? `$${totalMeal.toFixed(2)}` : '—'}</td>
              </>)}
            </tr>
          </tfoot>
        </table>
      </div>

      {adjusted.length > 0 && (
        <div style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: 8, padding: '10px 14px', marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.warning, marginBottom: 6 }}>✎ Hours adjusted after submission</div>
          {adjusted.map((l, i) => (
            <div key={l.id || i} style={{ fontSize: 12, color: C.textMuted, marginBottom: 3 }}>
              {fmtDate(l.date)}: originally submitted {fmtTime(l.original_start_time)} – {fmtTime(l.original_end_time)}
              {l.original_break_minutes != null ? ` (${l.original_break_minutes}m break)` : ''} · adjusted to {fmtTime(l.start_time)} – {fmtTime(l.end_time)} by {l.adjusted_by || 'admin'} on {fmtDateTime(l.adjusted_at)}
            </div>
          ))}
        </div>
      )}

      {header.comments && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Tasks completed</div>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: C.text, whiteSpace: 'pre-wrap' }}>{header.comments}</div>
        </div>
      )}

      {header.client_signature && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Client signature</div>
          {String(header.client_signature).startsWith('data:image')
            ? <img src={header.client_signature} alt="Client signature" style={{ maxWidth: 260, background: '#fff', borderRadius: 8, border: `1px solid ${C.border}` }} />
            : <div style={{ fontSize: 13, color: C.success }}>✓ Signed</div>}
        </div>
      )}

      {onClose && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary}>Close</button>
        </div>
      )}
    </div>
  );
}

// Opens a light, print-friendly window with the full timesheet and triggers the
// browser print dialog (workers/admins pick "Save as PDF" to get a file).
export function printTimesheet({ header, lines = [], workerName, brand = BRAND_DEFAULT }) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // The printed sheet goes to the client, so it shows TOTAL hours only. Normal /
  // RDO / OT / Meal are payroll detail — we pay the worker differently from how
  // we invoice the client (7.6h ordinary vs 8h billed), and showing the split
  // invited questions. Workers still record it; it stays on screen for the
  // office and flows through to payroll untouched.
  const totalHours = sumBy(lines, l => parseFloat(l.total_hours) || 0);
  const adjusted   = lines.filter(isAdjusted);

  // Audit trail for a disputed sheet: who signed it off, and when. The
  // supervisor sign-off chain already records this as client_approved_by/_at,
  // so prefer the explicit approver fields and fall back to those.
  const approvedBy = header.approved_by || header.client_approved_by || '';
  const approvedAt = header.approved_at || header.client_approved_at || '';

  const rows = lines.map(l => `
    <tr>
      <td>${esc(fmtDate(l.date))}${isAdjusted(l) ? ' ✎' : ''}</td>
      <td>${esc(dayFromDate(l.date))}</td>
      <td>${esc(l.shift_type || 'Day')}</td>
      <td>${esc(fmtTime(l.start_time))}</td>
      <td>${esc(fmtTime(l.end_time))}</td>
      <td>${esc(l.total_break_hours ? l.total_break_hours + 'h' : (l.break_minutes ? l.break_minutes + 'm' : '—'))}</td>
      <td><b>${Number(l.total_hours || 0).toFixed(2)}</b></td>
    </tr>`).join('');

  const adjustedBlock = adjusted.length ? `
    <div class="adjusted">
      <b>✎ Hours adjusted after submission</b>
      ${adjusted.map(l => `<div>${esc(fmtDate(l.date))}: originally submitted ${esc(fmtTime(l.original_start_time))} – ${esc(fmtTime(l.original_end_time))}${l.original_break_minutes != null ? ` (${l.original_break_minutes}m break)` : ''} · adjusted to ${esc(fmtTime(l.start_time))} – ${esc(fmtTime(l.end_time))} by ${esc(l.adjusted_by || 'admin')} on ${esc(fmtDateTime(l.adjusted_at))}</div>`).join('')}
    </div>` : '';

  const signatureBlock = header.client_signature
    ? (String(header.client_signature).startsWith('data:image')
        ? `<div class="sig"><div class="label">Client signature</div><img src="${header.client_signature}" alt="Client signature" /></div>`
        : `<div class="sig"><div class="label">Client signature</div>✓ Signed</div>`)
    : '';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(brand)} — Timesheet ${esc(workerName)} ${esc(fmtDate(lines[0]?.date))}</title>
  <style>
    body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111827; margin: 32px; }
    h1 { font-size: 20px; margin: 0 0 2px; } .sub { color: #6b7280; font-size: 12px; margin-bottom: 18px; }
    .meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 20px; margin-bottom: 18px; }
    .meta .label, .label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #6b7280; }
    .meta .val { font-size: 13px; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
    th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: #6b7280; border-bottom: 2px solid #e5e7eb; padding: 6px 8px; }
    td { font-size: 12.5px; border-bottom: 1px solid #f3f4f6; padding: 6px 8px; }
    tfoot td { border-top: 2px solid #e5e7eb; border-bottom: none; font-weight: 700; }
    .adjusted { background: #fffbeb; border: 1px solid #fcd34d; border-radius: 6px; padding: 10px 12px; font-size: 11.5px; margin: 12px 0; }
    .adjusted b { display: block; margin-bottom: 4px; color: #92400e; }
    .tasks { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px; font-size: 12.5px; white-space: pre-wrap; margin-top: 6px; }
    .sig { margin-top: 16px; } .sig img { max-width: 220px; border: 1px solid #e5e7eb; border-radius: 6px; }
    .status { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase;
      ${header.status === 'approved' ? 'background:#dcfce7;color:#15803d;' : header.status === 'rejected' ? 'background:#fee2e2;color:#b91c1c;' : 'background:#fef9c3;color:#a16207;'} }
    .footer { margin-top: 26px; font-size: 10.5px; color: #9ca3af; }
    @media print { body { margin: 12mm; } }
  </style></head><body>
    <h1>${esc(brand)} — Daily Timesheet</h1>
    <div class="sub">Status: <span class="status">${esc(header.status || 'pending')}</span>${approvedBy ? ` &nbsp;·&nbsp; Approved by <b>${esc(approvedBy)}</b>${approvedAt ? ` on ${esc(fmtDateTime(approvedAt))}` : ''}` : ''}</div>
    <div class="meta">
      <div><div class="label">Worker</div><div class="val">${esc(workerName || '—')}</div></div>
      <div><div class="label">Client</div><div class="val">${esc(header.client || '—')}</div></div>
      <div><div class="label">Project</div><div class="val">${esc(header.project || '—')}</div></div>
      <div><div class="label">Role</div><div class="val">${esc(header.role || '—')}</div></div>
      <div><div class="label">Wet hire</div><div class="val">${header.wet_hire ? 'Yes' : 'No'}</div></div>
    </div>
    <table>
      <thead><tr><th>Date</th><th>Day</th><th>Shift</th><th>Start</th><th>Finish</th><th>Break</th><th>Total</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="6">Totals</td><td>${totalHours.toFixed(2)}</td></tr></tfoot>
    </table>
    ${adjustedBlock}
    ${header.comments ? `<div class="label" style="margin-top:12px">Tasks completed</div><div class="tasks">${esc(header.comments)}</div>` : ''}
    ${signatureBlock}
    <div class="footer">Generated from the ${esc(brand)} portal on ${esc(new Date().toLocaleString('en-AU'))}</div>
    <script>window.onload = function () { window.print(); };</script>
  </body></html>`;

  openPrintWindow(html);
}

function openPrintWindow(html) {
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return;
  w.document.write(html);
  w.document.close();
}

// Print MANY timesheets as one document, one per page. This is what "download
// all the timesheets at once" needs: the browser's print dialog has a
// Save-as-PDF destination, so a batch of 40 sheets becomes a single 40-page PDF
// rather than 40 separate downloads.
export function printTimesheetBatch({ sheets = [], brand = BRAND_DEFAULT }) {
  if (!sheets.length) return;
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const page = ({ header, lines = [], workerName }) => {
    const totalHours = sumBy(lines, l => parseFloat(l.total_hours) || 0);
    const adjusted   = lines.filter(isAdjusted);
    const approvedBy = header.approved_by || header.client_approved_by || '';
    const approvedAt = header.approved_at || header.client_approved_at || '';
    const statusCss  = header.status === 'approved' ? 'background:#dcfce7;color:#15803d;'
                     : header.status === 'rejected' ? 'background:#fee2e2;color:#b91c1c;'
                     : 'background:#fef9c3;color:#a16207;';
    const rows = lines.map(l => `
      <tr>
        <td>${esc(fmtDate(l.date))}${isAdjusted(l) ? ' ✎' : ''}</td>
        <td>${esc(dayFromDate(l.date))}</td>
        <td>${esc(l.shift_type || 'Day')}</td>
        <td>${esc(fmtTime(l.start_time))}</td>
        <td>${esc(fmtTime(l.end_time))}</td>
        <td>${esc(l.total_break_hours ? l.total_break_hours + 'h' : (l.break_minutes ? l.break_minutes + 'm' : '—'))}</td>
        <td><b>${Number(l.total_hours || 0).toFixed(2)}</b></td>
      </tr>`).join('');
    const adjustedBlock = adjusted.length ? `
      <div class="adjusted"><b>✎ Hours adjusted after submission</b>
        ${adjusted.map(l => `<div>${esc(fmtDate(l.date))}: originally ${esc(fmtTime(l.original_start_time))} – ${esc(fmtTime(l.original_end_time))} · adjusted to ${esc(fmtTime(l.start_time))} – ${esc(fmtTime(l.end_time))} by ${esc(l.adjusted_by || 'admin')} on ${esc(fmtDateTime(l.adjusted_at))}</div>`).join('')}
      </div>` : '';
    return `
    <section class="sheet">
      <h1>${esc(brand)} — Daily Timesheet</h1>
      <div class="sub">Status: <span class="status" style="${statusCss}">${esc(header.status || 'pending')}</span>${approvedBy ? ` &nbsp;·&nbsp; Approved by <b>${esc(approvedBy)}</b>${approvedAt ? ` on ${esc(fmtDateTime(approvedAt))}` : ''}` : ''}</div>
      <div class="meta">
        <div><div class="label">Worker</div><div class="val">${esc(workerName || '—')}</div></div>
        <div><div class="label">Client</div><div class="val">${esc(header.client || '—')}</div></div>
        <div><div class="label">Project</div><div class="val">${esc(header.project || '—')}</div></div>
        <div><div class="label">Role</div><div class="val">${esc(header.role || '—')}</div></div>
        <div><div class="label">Wet hire</div><div class="val">${header.wet_hire ? 'Yes' : 'No'}</div></div>
      </div>
      <table>
        <thead><tr><th>Date</th><th>Day</th><th>Shift</th><th>Start</th><th>Finish</th><th>Break</th><th>Total</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="6">Totals</td><td>${totalHours.toFixed(2)}</td></tr></tfoot>
      </table>
      ${adjustedBlock}
      ${header.comments ? `<div class="label" style="margin-top:12px">Tasks completed</div><div class="tasks">${esc(header.comments)}</div>` : ''}
    </section>`;
  };

  const grand = sheets.reduce((s, x) => s + sumBy(x.lines || [], l => parseFloat(l.total_hours) || 0), 0);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(brand)} — ${sheets.length} timesheets</title>
  <style>
    body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111827; margin: 32px; }
    h1 { font-size: 20px; margin: 0 0 2px; } .sub { color: #6b7280; font-size: 12px; margin-bottom: 18px; }
    .meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 20px; margin-bottom: 18px; }
    .meta .label, .label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #6b7280; }
    .meta .val { font-size: 13px; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
    th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: #6b7280; border-bottom: 2px solid #e5e7eb; padding: 6px 8px; }
    td { font-size: 12.5px; border-bottom: 1px solid #f3f4f6; padding: 6px 8px; }
    tfoot td { border-top: 2px solid #e5e7eb; border-bottom: none; font-weight: 700; }
    .adjusted { background: #fffbeb; border: 1px solid #fcd34d; border-radius: 6px; padding: 10px 12px; font-size: 11.5px; margin: 12px 0; }
    .adjusted b { display: block; margin-bottom: 4px; color: #92400e; }
    .tasks { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px; font-size: 12.5px; white-space: pre-wrap; margin-top: 6px; }
    .status { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .cover { border-bottom: 2px solid #e5e7eb; padding-bottom: 14px; margin-bottom: 22px; }
    .cover .big { font-size: 22px; font-weight: 800; }
    /* one timesheet per page, but never a trailing blank page */
    .sheet { page-break-after: always; }
    .sheet:last-of-type { page-break-after: auto; }
    @media print { body { margin: 12mm; } }
  </style></head><body>
    <div class="cover">
      <div class="big">${esc(brand)} — Timesheets</div>
      <div class="sub" style="margin:6px 0 0">${sheets.length} timesheet${sheets.length === 1 ? '' : 's'} · ${grand.toFixed(2)} total hours · generated ${esc(new Date().toLocaleString('en-AU'))}</div>
    </div>
    ${sheets.map(page).join('')}
    <script>window.onload = function () { window.print(); };</script>
  </body></html>`;

  openPrintWindow(html);
}
