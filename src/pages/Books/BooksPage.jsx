import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary, btnSmall, btnSecondary } from '../../theme';
import { fmtDate, fmtDateTime, todayISO } from '../../utils/dates';
import { Spinner, Badge, TableWrap, Th, Td, EmptyState } from '../../components';
import { Card, Stat, CashBars, AgeingBuckets, Pill } from '../../components/books/BooksBits';
import { BooksAsk } from '../../components/books/BooksAsk';
import {
  fmtMoney, daysOverdue, basQuarter, monthOptions, monthBounds, isOurs, BOOKS_KIND_LABELS,
} from '../../utils/books';

// Books — the useful parts of A2Z Bookkeeping, inside the portal, on the
// portal's own Xero connection. MONEY page: AdminPortal renders it only for
// isMoneyUser, and every table it reads is locked to is_portal_admin() by RLS
// (20261109_books.sql), so a wrong caller gets empty tables, not an error.
// Data arrives through the books-sync edge function (hourly cron at :35, or
// "Sync now" here). Phone-first: cards stack at 360 px; only the Transactions
// table scrolls sideways, inside its own wrapper.

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'exceptions', label: 'Exceptions' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'debtors', label: 'Debtors' },
  { id: 'ask', label: 'Ask the books' },
];
const PAGE = 50;
const KIND_OPTIONS = [['', 'All kinds'], ...Object.entries(BOOKS_KIND_LABELS)];
const FLAG_LABEL = { duplicate: 'Duplicate', uncoded: 'Uncoded spend', large: 'Large claim', overdue_bill: 'Bill overdue' };
const FLAG_COLOR = { duplicate: 'orange', uncoded: 'yellow', large: 'red', overdue_bill: 'red' };

function useNarrow(px = 640) {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < px);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${px - 1}px)`);
    const on = () => setNarrow(mq.matches);
    on(); mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [px]);
  return narrow;
}

export function BooksPage({ showToast }) {
  const narrow = useNarrow();
  const today = todayISO();
  const quarter = useMemo(() => basQuarter(today), [today]);
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [connect, setConnect] = useState({ state: 'unknown', missing: [] });   // unknown | ready | reconnect | not_connected
  const [settings, setSettings] = useState(null);
  const [syncState, setSyncState] = useState([]);
  const [lastRun, setLastRun] = useState(null);
  const [bas, setBas] = useState(null);
  const [months, setMonths] = useState([]);
  const [ageing, setAgeing] = useState([]);
  const [exceptions, setExceptions] = useState([]);
  const [debtors, setDebtors] = useState([]);
  const [ourNumbers, setOurNumbers] = useState(new Set());

  // Transactions tab state
  const monthOpts = useMemo(() => monthOptions(today, 13), [today]);
  const [month, setMonth] = useState(monthOpts[0]?.value || '');
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [txns, setTxns] = useState([]);
  const [txnCount, setTxnCount] = useState(0);
  const [txnLoading, setTxnLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [st, run, settingsR, basR, monthsR, ageingR, excR, debtR, oursR] = await Promise.all([
      supabase.from('books_sync_state').select('endpoint, modified_since, last_ok_at, last_error, in_progress_run'),
      supabase.from('books_sync_runs').select('endpoint, started_at, finished_at, status, rows_upserted, page_reached, error').order('started_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('books_settings').select('*').eq('id', 1).maybeSingle(),
      supabase.rpc('books_bas_figures', { p_from: quarter.from, p_to: quarter.to }),
      supabase.rpc('books_cash_by_month', { p_months: 6 }),
      supabase.rpc('books_debtor_ageing'),
      supabase.rpc('books_exceptions'),
      supabase.from('books_open_items').select('xero_id, contact_name, number, issue_date, due_date, total, amount_due, amount_paid, status')
        .eq('item_type', 'ACCREC').gt('amount_due', 0).order('due_date', { ascending: true }).limit(500),
      supabase.from('client_invoices').select('xero_invoice_number').not('xero_invoice_number', 'is', null).limit(2000),
    ]);
    const firstErr = [st, run, settingsR, basR, monthsR, ageingR, excR, debtR].find((r) => r.error)?.error;
    if (firstErr) showToast?.(firstErr.message, 'error');
    setSyncState(st.data || []);
    setLastRun(run.data || null);
    setSettings(settingsR.data || null);
    setBas(Array.isArray(basR.data) ? basR.data[0] : basR.data);
    setMonths(monthsR.data || []);
    setAgeing(ageingR.data || []);
    setExceptions(excR.data || []);
    setDebtors(debtR.data || []);
    setOurNumbers(new Set((oursR.data || []).map((r) => String(r.xero_invoice_number || '').trim().toLowerCase()).filter(Boolean)));
    setLoading(false);
  }, [quarter.from, quarter.to, showToast]);

  // Are the Books scopes on the stored Xero token? (no Xero call, no sync)
  const checkConnection = useCallback(async () => {
    try {
      const { data, error } = await supabase.functions.invoke('books-sync', { body: { check: true } });
      if (error) { setConnect({ state: 'unknown', missing: [] }); return; }
      if (data?.reason === 'reconnect') setConnect({ state: 'reconnect', missing: data.missing || [] });
      else if (data?.reason === 'not_connected') setConnect({ state: 'not_connected', missing: [] });
      else setConnect({ state: 'ready', missing: data?.missing || [] });
    } catch { setConnect({ state: 'unknown', missing: [] }); }
  }, []);

  useEffect(() => { load(); checkConnection(); }, [load, checkConnection]);

  const loadTxns = useCallback(async () => {
    if (!month) return;
    setTxnLoading(true);
    const { from, to } = monthBounds(month);
    let q = supabase.from('books_transactions')
      .select('id, xero_id, kind, direction, is_cash, txn_date, contact_name, description, reference, invoice_number, total, gst, tax_type, account_code, account_name, bank_account, status, is_reconciled', { count: 'exact' })
      .gte('txn_date', from).lte('txn_date', to)
      .in('status', ['AUTHORISED', 'PAID'])
      .order('txn_date', { ascending: false }).order('xero_id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (kind) q = q.eq('kind', kind);
    const s = search.trim().replace(/[%,()]/g, ' ');
    if (s) q = q.or(`contact_name.ilike.%${s}%,description.ilike.%${s}%,reference.ilike.%${s}%,invoice_number.ilike.%${s}%,account_name.ilike.%${s}%`);
    const { data, error, count } = await q;
    if (error) showToast?.(error.message, 'error');
    setTxns(data || []);
    setTxnCount(count || 0);
    setTxnLoading(false);
  }, [month, kind, search, page, showToast]);

  useEffect(() => { if (tab === 'transactions') loadTxns(); }, [tab, loadTxns]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke('books-sync', { body: {} });
      if (error) { showToast?.(`Sync failed: ${error.message}`, 'error'); return; }
      if (data?.reason === 'reconnect') { setConnect({ state: 'reconnect', missing: data.missing || [] }); showToast?.('Reconnect Xero once to turn on Books.', 'error'); return; }
      if (data?.reason === 'not_connected') { setConnect({ state: 'not_connected', missing: [] }); showToast?.('Xero is not connected yet.', 'error'); return; }
      if (data?.ok === false) { showToast?.(data.message || 'Sync did not finish.', 'error'); return; }
      const done = (data?.results || []).map((r) => `${r.endpoint} ${r.status}${r.rows ? ` (${r.rows})` : ''}`).join(' · ');
      showToast?.(`Synced: ${done || 'nothing to do'}${data?.more ? ' — more pages are loading in the background' : ''}`, 'success');
      setConnect((c) => ({ ...c, state: 'ready' }));
      await load();
      if (tab === 'transactions') loadTxns();
    } finally {
      setSyncing(false);
    }
  };

  const connectXero = async () => {
    // Same door as Payroll: xero-start mints the one-time state and the consent URL.
    const { data, error } = await supabase.functions.invoke('xero-start', { method: 'GET' });
    if (error || !data?.auth_url) { showToast?.(`Could not start the Xero connection: ${error?.message || data?.error || 'not configured yet'}`, 'error'); return; }
    window.location.href = data.auth_url;
  };

  const lastOk = syncState.reduce((m, s) => (s.last_ok_at && (!m || s.last_ok_at > m) ? s.last_ok_at : m), null);
  const anyError = syncState.find((s) => s.last_error)?.last_error || null;
  const exCounts = exceptions.reduce((a, e) => { a[e.flag] = (a[e.flag] || 0) + 1; return a; }, {});
  const openInvoices = () => window.dispatchEvent(new CustomEvent('cbd:navigate', { detail: { page: 'invoices' } }));

  return (
    <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 20, color: C.text }}>📒 Books</h2>
          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
            {lastOk ? <>Last synced {fmtDateTime(lastOk)}</> : 'Never synced'}
            {lastRun?.status === 'running' && <> · <span style={{ color: '#fde047' }}>syncing {lastRun.endpoint} (page {lastRun.page_reached})…</span></>}
            {lastRun && lastRun.status !== 'running' && lastRun.status !== 'ok' && <> · <span style={{ color: '#fca5a5' }}>last run {lastRun.status}</span></>}
          </div>
        </div>
        <button onClick={syncNow} disabled={syncing} style={{ ...btnPrimary, minHeight: 40, opacity: syncing ? 0.7 : 1 }}>
          {syncing ? 'Syncing…' : '↻ Sync now'}
        </button>
      </div>

      {/* Reconnect banner */}
      {(connect.state === 'reconnect' || connect.state === 'not_connected') && (
        <div role="alert" style={{ background: C.warningSoft, border: `1px solid rgba(234,179,8,0.45)`, borderRadius: R.lg, padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <div style={{ color: '#fde047', fontWeight: 700, fontSize: 14 }}>
              {connect.state === 'reconnect' ? 'Reconnect Xero to turn on Books' : 'Connect Xero to turn on Books'}
            </div>
            <div style={{ color: C.textMuted, fontSize: 12, marginTop: 3, lineHeight: 1.45 }}>
              {connect.state === 'reconnect'
                ? <>The Xero connection was made before the Books permissions existed. Reconnecting once grants read-only access to bank transactions, payments and the chart of accounts. Nothing else changes.{connect.missing?.length ? <span style={{ fontFamily: MONO, display: 'block', marginTop: 3, color: C.textDim }}>missing: {connect.missing.join(' ')}</span> : null}</>
                : 'Xero is not connected yet. Connect it once from here or from the Payroll page.'}
            </div>
          </div>
          <button onClick={connectXero} style={{ ...btnPrimary, minHeight: 40 }}>{connect.state === 'reconnect' ? 'Reconnect Xero' : 'Connect Xero'}</button>
        </div>
      )}
      {anyError && connect.state === 'ready' && (
        <div style={{ background: C.errorSoft, border: '1px solid rgba(239,68,68,0.3)', borderRadius: R.md, padding: '8px 12px', fontSize: 12, color: '#fca5a5' }}>Last sync problem: {anyError}</div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2, WebkitOverflowScrolling: 'touch' }}>
        {TABS.map((t) => (
          <Pill key={t.id} active={tab === t.id} onClick={() => setTab(t.id)} count={t.id === 'exceptions' ? exceptions.length : t.id === 'debtors' ? debtors.length : undefined}>{t.label}</Pill>
        ))}
      </div>

      {loading && tab !== 'ask' ? <div style={{ padding: 30, textAlign: 'center' }}><Spinner /></div> : null}

      {/* Overview */}
      {!loading && tab === 'overview' && (
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: narrow ? '1fr' : 'repeat(auto-fit, minmax(340px, 1fr))' }}>
          <Card title={`BAS · ${quarter.label} · cash basis`} style={{ gridColumn: narrow ? 'auto' : '1 / -1' }}>
            <div style={{ display: 'grid', gridTemplateColumns: narrow ? 'repeat(2, minmax(0, 1fr))' : 'repeat(6, minmax(0, 1fr))', gap: 8 }}>
              <Stat label="G1 total sales" value={fmtMoney(bas?.g1)} tone="in" />
              <Stat label="G3 GST-free sales" value={fmtMoney(bas?.g3)} />
              <Stat label="G10 capital purchases" value={fmtMoney(bas?.g10)} />
              <Stat label="G11 other purchases" value={fmtMoney(bas?.g11)} tone="out" />
              <Stat label="1A GST on sales" value={fmtMoney(bas?.gst_1a)} tone="in" />
              <Stat label="1B GST on purchases" value={fmtMoney(bas?.gst_1b)} tone="out" />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginTop: 10, fontSize: 12, color: C.textMuted }}>
              <span>Net GST: <span style={{ fontFamily: MONO, color: C.text, fontWeight: 600 }}>{fmtMoney((Number(bas?.gst_1a) || 0) - (Number(bas?.gst_1b) || 0))}</span> · {Number(bas?.rows_counted) || 0} cash lines</span>
              <span style={{ color: C.textDim }}>{settings?.excluded_note || 'Not included: payroll journals, manual journals, transfers — read these in Xero.'}</span>
            </div>
          </Card>

          <Card title="Cash in / out · last 6 months"><CashBars months={months} /></Card>

          <Card title="Who owes us · by age"><AgeingBuckets buckets={ageing} /></Card>

          <Card title="Exceptions" right={<button onClick={() => setTab('exceptions')} style={btnSmall}>Open list →</button>}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
              {Object.keys(FLAG_LABEL).map((f) => (
                <Stat key={f} label={FLAG_LABEL[f]} value={String(exCounts[f] || 0)} hint={f === 'large' && settings ? `over ${fmtMoney(settings.large_claim_threshold)}` : f === 'overdue_bill' ? 'more than 30 days' : undefined} />
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* Exceptions */}
      {!loading && tab === 'exceptions' && (
        exceptions.length === 0
          ? <EmptyState icon="✅" message={lastOk ? 'No exceptions in the last 12 months of synced data.' : 'Nothing synced yet — press Sync now.'} />
          : (
            <div style={{ display: 'grid', gap: 8 }}>
              {exceptions.map((e, i) => {
                const ours = isOurs(e.number, ourNumbers);
                return (
                  <div key={`${e.flag}-${e.xero_id}-${i}`} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: R.md, padding: '10px 12px', display: 'grid', gap: 6, gridTemplateColumns: narrow ? '1fr' : '1fr auto', alignItems: 'center' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Badge label={FLAG_LABEL[e.flag] || e.flag} color={FLAG_COLOR[e.flag] || 'gray'} />
                        <span style={{ color: C.text, fontWeight: 600, fontSize: 13, overflowWrap: 'anywhere' }}>{e.contact_name || '(no contact)'}</span>
                        {e.number && <span style={{ fontFamily: MONO, fontSize: 11, color: C.textMuted }}>{e.number}</span>}
                        {ours && <Badge label="ours" color="blue" size="sm" />}
                      </div>
                      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, lineHeight: 1.45 }}>{e.reason}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: narrow ? 'space-between' : 'flex-end', flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: MONO, fontSize: 12, color: C.textMuted }}>{fmtDate(e.txn_date)}</span>
                      <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, color: C.text }}>{fmtMoney(e.amount)}</span>
                      {ours && <button onClick={openInvoices} style={btnSmall}>Invoices →</button>}
                    </div>
                  </div>
                );
              })}
            </div>
          )
      )}

      {/* Transactions */}
      {!loading && tab === 'transactions' && (
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: narrow ? '1fr 1fr' : 'auto auto 1fr' }}>
            <select value={month} onChange={(e) => { setMonth(e.target.value); setPage(0); }} style={{ ...inputStyle, minHeight: 42 }} aria-label="Month">
              {monthOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select value={kind} onChange={(e) => { setKind(e.target.value); setPage(0); }} style={{ ...inputStyle, minHeight: 42 }} aria-label="Kind">
              {KIND_OPTIONS.map(([v, l]) => <option key={v || 'all'} value={v}>{l}</option>)}
            </select>
            <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} placeholder="Search contact, description, reference, number…" style={{ ...inputStyle, minHeight: 42, gridColumn: narrow ? '1 / -1' : 'auto' }} aria-label="Search" />
          </div>
          {txnLoading ? <div style={{ padding: 20, textAlign: 'center' }}><Spinner /></div>
            : txns.length === 0 ? <EmptyState icon="📒" message="No transactions for this month and filter." />
            : narrow ? (
              <div style={{ display: 'grid', gap: 8 }}>
                {txns.map((t) => <TxnCard key={t.id} t={t} />)}
              </div>
            ) : (
              <TableWrap>
                <thead><tr><Th>Date</Th><Th>Kind</Th><Th>Contact</Th><Th>Description</Th><Th>Account</Th><Th align="right">GST</Th><Th align="right">Total</Th></tr></thead>
                <tbody>
                  {txns.map((t) => (
                    <tr key={t.id}>
                      <Td><span style={{ fontFamily: MONO, fontSize: 12 }}>{fmtDate(t.txn_date)}</span></Td>
                      <Td><Badge label={BOOKS_KIND_LABELS[t.kind] || t.kind} color={t.direction === 'in' ? 'green' : 'red'} size="sm" />{t.is_cash === false && <span style={{ marginLeft: 6 }}><Badge label="document" color="gray" size="sm" /></span>}</Td>
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
            <span>{txnCount} line{txnCount === 1 ? '' : 's'} · page {page + 1} of {Math.max(1, Math.ceil(txnCount / PAGE))}</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} style={{ ...btnSmall, minHeight: 36, opacity: page === 0 ? 0.5 : 1 }}>‹ Prev</button>
              <button onClick={() => setPage((p) => p + 1)} disabled={(page + 1) * PAGE >= txnCount} style={{ ...btnSmall, minHeight: 36, opacity: (page + 1) * PAGE >= txnCount ? 0.5 : 1 }}>Next ›</button>
            </span>
          </div>
        </div>
      )}

      {/* Debtors */}
      {!loading && tab === 'debtors' && (
        debtors.length === 0
          ? <EmptyState icon="🤝" message={lastOk ? 'No open sales invoices in Xero.' : 'Nothing synced yet — press Sync now.'} />
          : (
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontSize: 12, color: C.textMuted }}>
                {debtors.length} open invoice{debtors.length === 1 ? '' : 's'} · owed <span style={{ fontFamily: MONO, color: C.text, fontWeight: 600 }}>{fmtMoney(debtors.reduce((s, d) => s + (Number(d.amount_due) || 0), 0))}</span>
                {' '}· <Badge label="ours" color="blue" size="sm" /> = raised from this portal
              </div>
              {debtors.map((d) => {
                const late = daysOverdue(d.due_date, today);
                const ours = isOurs(d.number, ourNumbers);
                return (
                  <div key={d.xero_id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: R.md, padding: '10px 12px', display: 'grid', gap: 6, gridTemplateColumns: narrow ? '1fr' : '1fr auto', alignItems: 'center' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ color: C.text, fontWeight: 600, fontSize: 13, overflowWrap: 'anywhere' }}>{d.contact_name || '(no contact)'}</span>
                        <span style={{ fontFamily: MONO, fontSize: 11, color: C.textMuted }}>{d.number || '—'}</span>
                        {ours && <Badge label="ours" color="blue" size="sm" />}
                      </div>
                      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
                        Issued {fmtDate(d.issue_date)} · due {fmtDate(d.due_date)} · {late > 0
                          ? <span style={{ color: late > 30 ? '#fca5a5' : '#fde047', fontWeight: 600 }}>{late} day{late === 1 ? '' : 's'} overdue</span>
                          : <span style={{ color: '#86efac' }}>{late === 0 ? 'due today' : `due in ${-late} day${late === -1 ? '' : 's'}`}</span>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: narrow ? 'space-between' : 'flex-end', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: C.textDim, fontFamily: MONO }}>of {fmtMoney(d.total)}</span>
                      <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: C.text }}>{fmtMoney(d.amount_due)}</span>
                      {ours && <button onClick={openInvoices} style={btnSmall}>Invoices →</button>}
                    </div>
                  </div>
                );
              })}
            </div>
          )
      )}

      {/* Ask */}
      {tab === 'ask' && (
        <Card title="Ask the books">
          <BooksAsk disabled={connect.state === 'not_connected'} />
        </Card>
      )}

      {!loading && tab === 'overview' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={() => { load(); checkConnection(); }} style={btnSecondary}>Refresh figures</button>
        </div>
      )}
    </div>
  );
}

function TxnCard({ t }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: R.md, padding: '10px 12px', display: 'grid', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
          <Badge label={BOOKS_KIND_LABELS[t.kind] || t.kind} color={t.direction === 'in' ? 'green' : 'red'} size="sm" />
          <span style={{ fontFamily: MONO, fontSize: 11, color: C.textMuted }}>{fmtDate(t.txn_date)}</span>
        </span>
        <span style={{ fontFamily: MONO, fontWeight: 700, color: t.direction === 'in' ? '#86efac' : '#fca5a5' }}>{fmtMoney(t.total)}</span>
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
