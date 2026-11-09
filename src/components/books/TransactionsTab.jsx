import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnSmall } from '../../theme';
import { Spinner, Badge, TableWrap, Th, Td, EmptyState } from '../index';
import { CsvButton } from './BooksBits';
import { fmtMoney, monthBounds, BOOKS_KIND_LABELS } from '../../utils/books';
import { fmtDate } from '../../utils/dates';

// Synced cash lines, one month at a time, searchable. The only Books table
// that scrolls sideways — inside its own box.

const PAGE = 50;
const KIND_OPTIONS = [['', 'All kinds'], ...Object.entries(BOOKS_KIND_LABELS)];

export function TransactionsTab({ data, narrow, showToast }) {
  const { monthOpts } = data;
  const [month, setMonth] = useState(monthOpts[0]?.value || '');
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [txns, setTxns] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!month) return;
    setLoading(true);
    const { from, to } = monthBounds(month);
    let q = supabase.from('books_transactions')
      .select('id, xero_id, kind, direction, is_cash, txn_date, contact_name, description, reference, invoice_number, total, gst, tax_type, account_code, account_name, bank_account, status, is_reconciled, is_demo', { count: 'exact' })
      .gte('txn_date', from).lte('txn_date', to).in('status', ['AUTHORISED', 'PAID'])
      .order('txn_date', { ascending: false }).order('xero_id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (kind) q = q.eq('kind', kind);
    const s = search.trim().replace(/[%,()]/g, ' ');
    if (s) q = q.or(`contact_name.ilike.%${s}%,description.ilike.%${s}%,reference.ilike.%${s}%,invoice_number.ilike.%${s}%,account_name.ilike.%${s}%`);
    const { data: rows, error, count: n } = await q;
    if (error) showToast?.(error.message, 'error');
    setTxns(rows || []); setCount(n || 0); setLoading(false);
  }, [month, kind, search, page, showToast]);
  useEffect(() => { load(); }, [load]);

  const csv = txns.map((t) => ({ 'Date': t.txn_date, 'Kind': BOOKS_KIND_LABELS[t.kind] || t.kind, 'Contact': t.contact_name || '', 'Description': t.description || t.reference || '', 'Number': t.invoice_number || '', 'Account': t.account_name || t.account_code || '', 'Tax': t.tax_type || '', 'GST': Number(t.gst || 0).toFixed(2), 'Total': Number(t.total || 0).toFixed(2), 'Reconciled': t.is_reconciled === false ? 'no' : t.is_reconciled ? 'yes' : '' }));

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: narrow ? '1fr 1fr' : 'auto auto 1fr auto', alignItems: 'center' }}>
        <select value={month} onChange={(e) => { setMonth(e.target.value); setPage(0); }} style={{ ...inputStyle, minHeight: 42 }} aria-label="Month">
          {monthOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={kind} onChange={(e) => { setKind(e.target.value); setPage(0); }} style={{ ...inputStyle, minHeight: 42 }} aria-label="Kind">
          {KIND_OPTIONS.map(([v, l]) => <option key={v || 'all'} value={v}>{l}</option>)}
        </select>
        <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} placeholder="Search contact, description, number…" style={{ ...inputStyle, minHeight: 42, gridColumn: narrow ? '1 / -1' : 'auto' }} aria-label="Search" />
        <span style={{ gridColumn: narrow ? '1 / -1' : 'auto', justifySelf: 'end' }}><CsvButton rows={csv} filename={`transactions-${month}.csv`} label="CSV (page)" /></span>
      </div>
      {loading ? <div style={{ padding: 20, textAlign: 'center' }}><Spinner /></div>
        : txns.length === 0 ? <EmptyState icon="📒" message="No transactions for this month and filter." />
        : narrow ? <div style={{ display: 'grid', gap: 8 }}>{txns.map((t) => <TxnCard key={t.id} t={t} />)}</div>
        : (
          <TableWrap>
            <thead><tr><Th>Date</Th><Th>Kind</Th><Th>Contact</Th><Th>Description</Th><Th>Account</Th><Th align="right">GST</Th><Th align="right">Total</Th></tr></thead>
            <tbody>
              {txns.map((t) => (
                <tr key={t.id}>
                  <Td><span style={{ fontFamily: MONO, fontSize: 12 }}>{fmtDate(t.txn_date)}</span></Td>
                  <Td><Badge label={BOOKS_KIND_LABELS[t.kind] || t.kind} color={t.direction === 'in' ? 'green' : 'red'} size="sm" />{t.is_cash === false && <span style={{ marginLeft: 6 }}><Badge label="document" color="gray" size="sm" /></span>}{t.is_demo && <span style={{ marginLeft: 6 }}><Badge label="demo" color="purple" size="sm" /></span>}</Td>
                  <Td>{t.contact_name || '—'}</Td>
                  <Td title={t.reference || ''}><span style={{ color: C.textMuted }}>{t.invoice_number ? <span style={{ fontFamily: MONO, marginRight: 6 }}>{t.invoice_number}</span> : null}{t.description || t.reference || '—'}</span></Td>
                  <Td><span style={{ fontSize: 12, color: C.textMuted }}>{t.account_name || t.account_code || <span style={{ color: '#fde047' }}>uncoded</span>}{t.tax_type ? <span style={{ fontFamily: MONO, marginLeft: 6, color: C.textDim }}>{t.tax_type}</span> : null}</span></Td>
                  <Td align="right"><span style={{ fontFamily: MONO, fontSize: 12 }}>{fmtMoney(t.gst)}</span></Td>
                  <Td align="right"><span style={{ fontFamily: MONO, fontWeight: 600, color: t.direction === 'in' ? '#86efac' : '#fca5a5' }}>{fmtMoney(t.total)}</span></Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12, color: C.textMuted }}>
        <span>{count} line{count === 1 ? '' : 's'} · page {page + 1} of {Math.max(1, Math.ceil(count / PAGE))}</span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} style={{ ...btnSmall, minHeight: 36, opacity: page === 0 ? 0.5 : 1 }}>‹ Prev</button>
          <button onClick={() => setPage((p) => p + 1)} disabled={(page + 1) * PAGE >= count} style={{ ...btnSmall, minHeight: 36, opacity: (page + 1) * PAGE >= count ? 0.5 : 1 }}>Next ›</button>
        </span>
      </div>
    </div>
  );
}

function TxnCard({ t }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: R.md, padding: '10px 12px', display: 'grid', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0, flexWrap: 'wrap' }}>
          <Badge label={BOOKS_KIND_LABELS[t.kind] || t.kind} color={t.direction === 'in' ? 'green' : 'red'} size="sm" />
          {t.is_demo && <Badge label="demo" color="purple" size="sm" />}
          <span style={{ fontFamily: MONO, fontSize: 11, color: C.textMuted }}>{fmtDate(t.txn_date)}</span>
        </span>
        <span style={{ fontFamily: MONO, fontWeight: 700, color: t.direction === 'in' ? '#86efac' : '#fca5a5', whiteSpace: 'nowrap' }}>{fmtMoney(t.total)}</span>
      </div>
      <div style={{ color: C.text, fontWeight: 600, fontSize: 13, overflowWrap: 'anywhere' }}>{t.contact_name || '—'}</div>
      <div style={{ fontSize: 12, color: C.textMuted, overflowWrap: 'anywhere' }}>{t.invoice_number ? <span style={{ fontFamily: MONO, marginRight: 6 }}>{t.invoice_number}</span> : null}{t.description || t.reference || ''}</div>
      <div style={{ fontSize: 11, color: C.textDim, display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span>{t.account_name || t.account_code || <span style={{ color: '#fde047' }}>uncoded</span>}{t.tax_type ? ` · ${t.tax_type}` : ''}</span>
        <span style={{ fontFamily: MONO }}>GST {fmtMoney(t.gst)}</span>
      </div>
    </div>
  );
}
