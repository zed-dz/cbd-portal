import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, btnPrimary, btnSecondary } from '../../theme';
import { fmtDate, fmtDateTime } from '../../utils/dates';
import { downloadCSV } from '../../utils/csv';
import { Spinner, TableWrap, Th, Td, EmptyState } from '../../components';
import { InvoiceStatusChip, checkInvoicePayments } from '../../components/accounting/InvoiceStatusChip';
import {
  INVOICE_FILTERS, matchesFilter, invoiceTotals, invoiceAmounts, invoiceChip, fmtISODate, sydneyTodayISO,
} from '../../utils/invoiceStatus';

// Client invoices (admin only — every row carries dollars; RLS: is_portal_admin).
// Status comes back from Xero via the xero-invoice-sync function: daily cron at
// 06:00/07:00 Sydney, or "↻ Check payments" here / on a client's register.

const COLS = 'id, client, client_id, source, period_from, period_to, created_at, amount_cents, currency, status, error, '
  + 'xero_invoice_id, xero_invoice_number, xero_status, xero_url, total, amount_paid, amount_due, due_date, fully_paid_on, xero_synced_at, sync_error';

const money = (n) => (n === null || n === undefined ? '—'
  : `$${Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

function useIsNarrow(px = 700) {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < px);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < px);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [px]);
  return narrow;
}

export function InvoicesPage({ showToast }) {
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState('all');
  const [checking, setChecking] = useState(false);
  const narrow = useIsNarrow();
  const today = sydneyTodayISO();

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('client_invoices').select(COLS)
      .order('created_at', { ascending: false }).limit(1000);
    if (error) { showToast?.(error.message, 'error'); setRows([]); return; }
    setRows(data || []);
  }, [showToast]);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => (rows || []).filter(r => matchesFilter(r, filter, today)), [rows, filter, today]);
  const totals = useMemo(() => invoiceTotals(rows || [], today), [rows, today]);
  const counts = useMemo(() => Object.fromEntries(INVOICE_FILTERS.map(f => [f.id, (rows || []).filter(r => matchesFilter(r, f.id, today)).length])), [rows, today]);
  const lastSync = useMemo(() => (rows || []).map(r => r.xero_synced_at).filter(Boolean).sort().pop() || null, [rows]);

  const check = async () => {
    setChecking(true);
    try { await checkInvoicePayments({ showToast }); await load(); } finally { setChecking(false); }
  };

  const exportCSV = () => {
    downloadCSV(`client-invoices-${filter}-${today}.csv`, shown.map(r => {
      const a = invoiceAmounts(r);
      return {
        Client: r.client || '',
        Number: r.xero_invoice_number || '',
        Source: r.source || '',
        Date: r.created_at ? fmtDate(r.created_at) : '',
        Period: r.period_from ? `${fmtISODate(r.period_from)} - ${fmtISODate(r.period_to)}` : '',
        Due: fmtISODate(r.due_date),
        Total: a.total != null ? a.total.toFixed(2) : '',
        'Total basis': a.synced ? 'Xero (inc GST)' : 'Portal (ex GST)',
        Paid: a.paid != null ? a.paid.toFixed(2) : '',
        'Amount due': a.due != null ? a.due.toFixed(2) : '',
        Status: invoiceChip(r, today).label,
        'Paid on': fmtISODate(r.fully_paid_on),
        'Last checked': r.xero_synced_at ? fmtDateTime(r.xero_synced_at) : '',
        'Check problem': r.sync_error || '',
        'Xero link': r.xero_url || '',
      };
    }));
  };

  if (rows === null) return <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner /></div>;

  const xeroLink = (r) => r.xero_url
    ? <a href={r.xero_url} target="_blank" rel="noopener noreferrer" style={{ color: '#13B5EA', fontWeight: 600, whiteSpace: 'nowrap' }}>View in Xero ↗</a>
    : <span style={{ color: C.textDim }}>—</span>;

  return (
    <div data-area="client invoices" style={{ paddingBottom: narrow ? 84 : 0 }}>
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 20, color: C.text }}>🧾 Invoices</h2>
        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, lineHeight: 1.5 }}>
          Client invoices and whether they are paid. Xero is checked every morning;
          {lastSync ? <> last check <span style={{ fontFamily: MONO }}>{fmtDateTime(lastSync)}</span>.</> : ' not checked yet.'}
        </div>
      </div>

      {/* Totals */}
      <div data-area="invoice totals" style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr 1fr' : 'repeat(4, minmax(0, 200px))', gap: 10, marginBottom: 14 }}>
        <Stat label="Outstanding" value={money(totals.outstanding)} sub={`${totals.unpaidCount} unpaid`} color={C.warning} />
        <Stat label="Overdue" value={money(totals.overdue)} sub={`${totals.overdueCount} overdue`} color={totals.overdueCount ? C.error : C.textMuted} />
      </div>

      {/* Filters + actions */}
      <div data-area="invoice filters" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <div role="tablist" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {INVOICE_FILTERS.map(f => {
            const on = filter === f.id;
            return (
              <button key={f.id} type="button" role="tab" aria-selected={on} onClick={() => setFilter(f.id)}
                style={{ ...btnSecondary, padding: '8px 12px', fontSize: 12, minHeight: 36,
                  background: on ? C.accentSoft : 'transparent', borderColor: on ? C.accentBorder : C.border, color: on ? C.accent : C.text }}>
                {f.label} ({counts[f.id] || 0})
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', width: narrow ? '100%' : 'auto', marginLeft: narrow ? 0 : 'auto' }}>
          <button type="button" onClick={check} disabled={checking}
            title="Ask Xero now whether open invoices are paid, overdue or voided."
            style={{ ...btnPrimary, padding: '8px 14px', fontSize: 12, minHeight: 36, flex: narrow ? '1 1 100%' : '0 0 auto', opacity: checking ? 0.6 : 1 }}>
            {checking ? 'Checking Xero…' : '↻ Check payments'}
          </button>
          <button type="button" onClick={exportCSV} disabled={!shown.length}
            style={{ ...btnSecondary, padding: '8px 12px', fontSize: 12, minHeight: 36, flex: narrow ? '1 1 100%' : '0 0 auto', opacity: shown.length ? 1 : 0.5 }}>
            ⬇ Export CSV ({shown.length})
          </button>
        </div>
      </div>

      {!shown.length ? (
        <EmptyState icon="🧾" message={rows.length
          ? 'No invoices match this filter.'
          : 'No client invoices yet. Create one from Clients & Rates → a client → Timesheets → "🧾 Xero invoice (draft)".'} />
      ) : narrow ? (
        <div data-area="invoice list" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {shown.map(r => {
            const a = invoiceAmounts(r);
            return (
              <div key={r.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: R.lg, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: C.text, overflowWrap: 'anywhere' }}>{r.client || '—'}</div>
                    <div style={{ fontSize: 12, color: C.textMuted, fontFamily: MONO }}>{r.xero_invoice_number || (r.source === 'stripe' ? 'Stripe' : '—')} · {r.created_at ? fmtDate(r.created_at) : '—'}</div>
                  </div>
                  <InvoiceStatusChip invoice={r} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginTop: 10, fontSize: 12 }}>
                  <Mini label="Total" value={money(a.total)} />
                  <Mini label="Paid" value={money(a.paid)} />
                  <Mini label="Due" value={money(a.due)} strong />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 10, fontSize: 12, color: C.textMuted, flexWrap: 'wrap' }}>
                  <span>Due date {r.due_date ? fmtISODate(r.due_date) : '—'}</span>
                  {xeroLink(r)}
                </div>
                {r.sync_error && <div style={{ marginTop: 6, fontSize: 11, color: C.warning }}>⚠ {r.sync_error}</div>}
              </div>
            );
          })}
        </div>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>Client</Th><Th>Number</Th><Th>Date</Th><Th>Due</Th>
              <Th align="right">Total</Th><Th align="right">Paid</Th><Th align="right">Due amount</Th>
              <Th>Status</Th><Th>Xero</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map(r => {
              const a = invoiceAmounts(r);
              return (
                <tr key={r.id}>
                  <Td><strong>{r.client || '—'}</strong>{r.period_from && <div style={{ fontSize: 11, color: C.textDim }}>{fmtISODate(r.period_from)} – {fmtISODate(r.period_to)}</div>}</Td>
                  <Td style={{ fontFamily: MONO, fontSize: 12 }}>{r.xero_invoice_number || (r.source === 'stripe' ? 'Stripe' : '—')}</Td>
                  <Td style={{ fontFamily: MONO, fontSize: 12 }}>{r.created_at ? fmtDate(r.created_at) : '—'}</Td>
                  <Td style={{ fontFamily: MONO, fontSize: 12 }}>{r.due_date ? fmtISODate(r.due_date) : '—'}</Td>
                  <Td align="right" style={{ fontFamily: MONO }} title={a.synced ? 'From Xero, inc GST' : 'Portal figure, ex GST (not yet checked in Xero)'}>{money(a.total)}{!a.synced && a.total != null && <span style={{ color: C.textDim }}>*</span>}</Td>
                  <Td align="right" style={{ fontFamily: MONO }}>{money(a.paid)}</Td>
                  <Td align="right" style={{ fontFamily: MONO, fontWeight: 600 }}>{money(a.due)}</Td>
                  <Td><InvoiceStatusChip invoice={r} /></Td>
                  <Td>{xeroLink(r)}</Td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
      {shown.length > 0 && (
        <div style={{ fontSize: 11, color: C.textDim, marginTop: 8, lineHeight: 1.5 }}>
          Amounts from Xero include GST. * = not checked in Xero yet (portal figure, ex GST). Hover a chip for the due date and any check problem.
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, color }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: R.lg, padding: '10px 12px', minWidth: 0 }}>
      <div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color, fontFamily: MONO, overflowWrap: 'anywhere' }}>{value}</div>
      <div style={{ fontSize: 11, color: C.textDim }}>{sub}</div>
    </div>
  );
}

function Mini({ label, value, strong }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontFamily: MONO, fontWeight: strong ? 700 : 500, color: C.text, overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  );
}
