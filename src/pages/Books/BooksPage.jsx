import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, btnPrimary, btnSmall, btnSecondary, inputStyle } from '../../theme';
import { fmtDateTime } from '../../utils/dates';
import { Spinner } from '../../components';
import { Card, Stat, CashBars, AgeingBuckets, DemoBanner, useNarrow, tabBtn, Num } from '../../components/books/BooksBits';
import { BooksAsk } from '../../components/books/BooksAsk';
import { useBooksData } from '../../components/books/useBooksData';
import { MarginTab } from '../../components/books/MarginTab';
import { CashflowTab } from '../../components/books/CashflowTab';
import { DebtorsTab } from '../../components/books/DebtorsTab';
import { ComplianceTab } from '../../components/books/ComplianceTab';
import { CloseTab } from '../../components/books/CloseTab';
import { ReceiptsTab } from '../../components/books/ReceiptsTab';
import { PnlTab } from '../../components/books/PnlTab';
import { ExceptionsTab } from '../../components/books/ExceptionsTab';
import { TransactionsTab } from '../../components/books/TransactionsTab';
import { fmtMoney, daysOverdue, monthLabel } from '../../utils/books';
import { shiftMarginRows, groupMargin, marginTotals, marginLeaks } from '../../utils/booksMargin';
import { pnlByMonth } from '../../utils/booksPnl';
import { upcomingObligations, complianceEstimates } from '../../utils/booksCompliance';
import { rollForwardBalance, weeklyPayroll, recurringBills, buildForecast, daysLateByContact } from '../../utils/booksForecast';
import { exceptionsV2 } from '../../utils/booksExceptions';
import { buildReportPackHTML, openReportPack } from '../../utils/booksReport';

// Books v2 — small-business bookkeeping inside the portal, on the portal's own
// Xero connection + its own timesheets. MONEY page: AdminPortal renders it only
// for isMoneyUser and every table is locked to is_portal_admin() by RLS.
// Phone-first: cards stack at 360 px; only tables scroll, inside their box.

const TABS = [
  ['overview', 'Overview'], ['margin', 'Margin'], ['cashflow', 'Cash flow'], ['debtors', 'Debtors'], ['compliance', 'Compliance'],
  ['close', 'Close'], ['receipts', 'Receipts'], ['pnl', 'P&L'], ['exceptions', 'Exceptions'], ['transactions', 'Transactions'], ['ask', 'Ask'],
];

export function BooksPage({ showToast, currentWorker }) {
  const narrow = useNarrow();
  const data = useBooksData(showToast);
  const who = currentWorker?.email || currentWorker?.name || null;
  const [tab, setTab] = useState('overview');
  const [syncing, setSyncing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [connect, setConnect] = useState({ state: 'unknown', missing: [] });
  const [packMonth, setPackMonth] = useState(() => data.monthOpts[1]?.value || data.monthOpts[0]?.value);

  const checkConnection = useCallback(async () => {
    try {
      const { data: r, error } = await supabase.functions.invoke('books-sync', { body: { check: true } });
      if (error) { setConnect({ state: 'unknown', missing: [] }); return; }
      if (r?.reason === 'reconnect') setConnect({ state: 'reconnect', missing: r.missing || [] });
      else if (r?.reason === 'not_connected') setConnect({ state: 'not_connected', missing: [] });
      else setConnect({ state: 'ready', missing: r?.missing || [] });
    } catch { setConnect({ state: 'unknown', missing: [] }); }
  }, []);
  useEffect(() => { checkConnection(); }, [checkConnection]);

  // Jump to a tab from the help bubble / close checklist.
  useEffect(() => {
    const on = (e) => { const t = e.detail?.tab; if (t && TABS.some(([id]) => id === t)) setTab(t); };
    window.addEventListener('cbd:books-tab', on);
    return () => window.removeEventListener('cbd:books-tab', on);
  }, []);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const { data: r, error } = await supabase.functions.invoke('books-sync', { body: {} });
      if (error) { showToast?.(`Sync failed: ${error.message}`, 'error'); return; }
      if (r?.reason === 'reconnect') { setConnect({ state: 'reconnect', missing: r.missing || [] }); showToast?.('Reconnect Xero once to turn on Books.', 'error'); return; }
      if (r?.reason === 'not_connected') { setConnect({ state: 'not_connected', missing: [] }); showToast?.('Xero is not connected yet.', 'error'); return; }
      if (r?.ok === false) { showToast?.(r.message || 'Sync did not finish.', 'error'); return; }
      const done = (r?.results || []).map((x) => `${x.endpoint} ${x.status}${x.rows ? ` (${x.rows})` : ''}`).join(' · ');
      showToast?.(`Synced: ${done || 'nothing to do'}${r?.more ? ' — more pages are loading in the background' : ''}`, 'success');
      setConnect((c) => ({ ...c, state: 'ready' }));
      await data.reload();
    } finally { setSyncing(false); }
  };
  const connectXero = async () => {
    const { data: r, error } = await supabase.functions.invoke('xero-start', { method: 'GET' });
    if (error || !r?.auth_url) { showToast?.(`Could not start the Xero connection: ${error?.message || r?.error || 'not configured yet'}`, 'error'); return; }
    window.location.href = r.auth_url;
  };
  const removeDemo = async () => {
    setRemoving(true);
    const { data: n, error } = await supabase.rpc('books_remove_demo');
    setRemoving(false);
    if (error) { showToast?.(error.message, 'error'); return; }
    showToast?.(`Removed ${n} demo row${n === 1 ? '' : 's'}.`, 'success');
    await data.reload();
  };

  const lastOk = data.syncState.reduce((m, s) => (s.last_ok_at && (!m || s.last_ok_at > m) ? s.last_ok_at : m), null);
  const anyError = data.syncState.find((s) => s.last_error)?.last_error || null;
  const goTab = (t) => { if (TABS.some(([id]) => id === t)) setTab(t); else window.dispatchEvent(new CustomEvent('cbd:navigate', { detail: { page: t } })); };

  // Overview figures (cheap recomputes of the tab maths).
  const ov = useMemo(() => {
    if (data.loading) return null;
    const live = data.transactions.filter((t) => t.is_cash && ['AUTHORISED', 'PAID'].includes(String(t.status || 'AUTHORISED').toUpperCase()));
    const rows = shiftMarginRows(data);
    const totals = marginTotals(rows);
    const leaks = marginLeaks(rows, Number(data.settings?.margin_floor_pct) || 15);
    const debtors = data.openItems.filter((o) => o.item_type === 'ACCREC');
    const overdue = debtors.filter((d) => daysOverdue(d.due_date, data.today) > 0);
    const opening = rollForwardBalance(data.settings?.bank_balance, data.settings?.bank_balance_date, live, data.today);
    const payroll = weeklyPayroll(live, data.today, rows.length ? totals.pay / Math.max(1, new Set(rows.map((r) => r.week)).size) : 0);
    const estimates = complianceEstimates({ bas: data.bas, grossPay: payroll.weekly * 4, settings: data.settings || {} });
    const obligations = upcomingObligations(data.today, data.settings || {}, estimates, 3);
    const lateMap = daysLateByContact(data.invoices.filter((i) => i.fully_paid_on && i.due_date).map((i) => ({ contact: i.client, due_date: i.due_date, paid_date: i.fully_paid_on })));
    const fc = buildForecast({ today: data.today, opening, openItems: debtors, lateMap, payroll, bills: recurringBills(live, data.today), obligations });
    const v2 = exceptionsV2({ transactions: data.transactions, invoices: data.invoices, timesheets: data.tsLite.filter((t) => String(t.status).toLowerCase() === 'approved'), today: data.today });
    const toReview = data.receipts.filter((r) => ['new', 'matched'].includes(r.status)).length;
    return { totals, leaks, debtors, overdue, opening, fc, obligations, estimates, exCount: data.sqlExceptions.length + v2.length, v2, toReview, rows };
  }, [data]);

  const printPack = () => {
    if (!ov) return;
    const months = data.monthOpts.slice(0, 6).map((m) => m.value).reverse();
    const pnl = pnlByMonth(data.transactions, data.accounts, months.includes(packMonth) ? months : [...months, packMonth].sort());
    const close = data.closes.find((c) => String(c.month).slice(0, 7) === packMonth);
    const html = buildReportPackHTML({
      brand: (document.title.split(/[·—]/)[0] || '').trim() || 'Portal', month: packMonth, today: data.today, pnl,
      margin: { period: data.marginRange, totals: ov.totals, client: groupMargin(ov.rows, 'client'), leaks: ov.leaks },
      debtors: ov.debtors, bas: data.bas, quarter: data.quarter, exceptions: [...data.sqlExceptions, ...ov.v2], obligations: ov.obligations, forecast: ov.fc,
      close: close ? { closed: !!(close.closed_at && !close.reopened_at), closed_at: close.closed_at, closed_by: close.closed_by, checklist: close.checklist } : null,
      cashMonths: data.months,
    });
    if (!openReportPack(html)) showToast?.('Allow pop-ups to open the report.', 'error');
  };

  return (
    <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 20, color: C.text }}>📒 Books</h2>
          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
            {lastOk ? <>Synced {fmtDateTime(lastOk)}</> : 'Never synced'}
            {data.lastRun?.status === 'running' && <> · <span style={{ color: '#fde047' }}>syncing {data.lastRun.endpoint} (page {data.lastRun.page_reached})…</span></>}
            {data.lastRun && data.lastRun.status !== 'running' && data.lastRun.status !== 'ok' && <> · <span style={{ color: '#fca5a5' }}>last run {data.lastRun.status}</span></>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => { data.reload(); checkConnection(); }} style={{ ...btnSecondary, minHeight: 40 }}>Refresh</button>
          <button onClick={syncNow} disabled={syncing} style={{ ...btnPrimary, minHeight: 40, opacity: syncing ? 0.7 : 1 }}>{syncing ? 'Syncing…' : '↻ Sync now'}</button>
        </div>
      </div>

      <DemoBanner count={data.demoCount} onRemove={removeDemo} busy={removing} />

      {(connect.state === 'reconnect' || connect.state === 'not_connected') && (
        <div role="alert" style={{ background: C.warningSoft, border: '1px solid rgba(234,179,8,0.45)', borderRadius: R.lg, padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <div style={{ color: '#fde047', fontWeight: 700, fontSize: 14 }}>{connect.state === 'reconnect' ? 'Reconnect Xero to turn on Books' : 'Connect Xero to turn on Books'}</div>
            <div style={{ color: C.textMuted, fontSize: 12, marginTop: 3 }}>
              {connect.state === 'reconnect' ? <>Read-only access to bank transactions, payments and the chart of accounts.{connect.missing?.length ? <span style={{ fontFamily: MONO, display: 'block', marginTop: 3, color: C.textDim }}>missing: {connect.missing.join(' ')}</span> : null}</> : 'Connect it once from here or from Payroll.'}
            </div>
          </div>
          <button onClick={connectXero} style={{ ...btnPrimary, minHeight: 40 }}>{connect.state === 'reconnect' ? 'Reconnect Xero' : 'Connect Xero'}</button>
        </div>
      )}
      {anyError && connect.state === 'ready' && <div style={{ background: C.errorSoft, border: '1px solid rgba(239,68,68,0.3)', borderRadius: R.md, padding: '8px 12px', fontSize: 12, color: '#fca5a5' }}>Last sync problem: {anyError}</div>}

      <div role="tablist" style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2, WebkitOverflowScrolling: 'touch' }}>
        {TABS.map(([id, label]) => {
          const n = id === 'exceptions' ? ov?.exCount : id === 'debtors' ? ov?.debtors.length : id === 'receipts' ? ov?.toReview : undefined;
          return (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} style={tabBtn(tab === id)}>
              {label}{n ? <span style={{ marginLeft: 6, fontFamily: MONO, fontSize: 11, opacity: 0.85 }}>{n}</span> : null}
            </button>
          );
        })}
      </div>

      {data.loading && tab !== 'ask' ? <div style={{ padding: 30, textAlign: 'center' }}><Spinner /></div> : null}

      {!data.loading && tab === 'overview' && ov && (
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: narrow ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
            <Stat label="Bank today" value={ov.opening === null ? '—' : fmtMoney(ov.opening)} hint={ov.opening === null ? 'type it on Cash flow' : ov.fc.runway_week ? `below zero ${monthLabel(ov.fc.runway_week.slice(0, 7))}` : '13+ weeks runway'} tone={ov.fc.runway_week ? 'out' : undefined} />
            <Stat label="Gross margin" value={`${ov.totals.margin_pct.toFixed(1)}%`} hint={`${fmtMoney(ov.totals.margin)} · ${ov.leaks.length} leak${ov.leaks.length === 1 ? '' : 's'}`} tone={ov.totals.margin < 0 ? 'out' : 'in'} />
            <Stat label="Owed to us" value={fmtMoney(ov.debtors.reduce((s, d) => s + (Number(d.amount_due) || 0), 0))} hint={`${ov.overdue.length} overdue`} tone={ov.overdue.length ? 'out' : undefined} />
            <Stat label="Next ATO date" value={ov.obligations[0] ? `${ov.obligations[0].days_left} d` : '—'} hint={ov.obligations[0]?.label} />
          </div>
          <div style={{ display: 'grid', gap: 14, gridTemplateColumns: narrow ? '1fr' : 'repeat(auto-fit, minmax(340px, 1fr))' }}>
            <Card title={`BAS · ${data.quarter.label} · cash basis`} style={{ gridColumn: narrow ? 'auto' : '1 / -1' }}>
              <div style={{ display: 'grid', gridTemplateColumns: narrow ? 'repeat(2, minmax(0, 1fr))' : 'repeat(6, minmax(0, 1fr))', gap: 8 }}>
                <Stat label="G1 total sales" value={fmtMoney(data.bas?.g1)} tone="in" />
                <Stat label="G3 GST-free sales" value={fmtMoney(data.bas?.g3)} />
                <Stat label="G10 capital purchases" value={fmtMoney(data.bas?.g10)} />
                <Stat label="G11 other purchases" value={fmtMoney(data.bas?.g11)} tone="out" />
                <Stat label="1A GST on sales" value={fmtMoney(data.bas?.gst_1a)} tone="in" />
                <Stat label="1B GST on purchases" value={fmtMoney(data.bas?.gst_1b)} tone="out" />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginTop: 10, fontSize: 12, color: C.textMuted }}>
                <span>Net GST: <Num v={(Number(data.bas?.gst_1a) || 0) - (Number(data.bas?.gst_1b) || 0)} bold /> · {Number(data.bas?.rows_counted) || 0} cash lines</span>
                <span style={{ color: C.textDim }}>{data.settings?.excluded_note || 'Not included: payroll journals, manual journals, transfers.'}</span>
              </div>
            </Card>
            <Card title="Cash in / out · 6 months"><CashBars months={data.months} /></Card>
            <Card title="Who owes us · by age" right={<button onClick={() => setTab('debtors')} style={btnSmall}>Debtors →</button>}><AgeingBuckets buckets={data.ageing} /></Card>
            <Card title="To do" right={<button onClick={() => setTab('close')} style={btnSmall}>Close →</button>}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
                <Stat label="Exceptions" value={String(ov.exCount)} tone={ov.exCount ? 'out' : undefined} />
                <Stat label="Receipts to review" value={String(ov.toReview)} />
                <Stat label="Margin leaks" value={String(ov.leaks.length)} tone={ov.leaks.length ? 'out' : undefined} />
                <Stat label="Overdue invoices" value={String(ov.overdue.length)} tone={ov.overdue.length ? 'out' : undefined} />
              </div>
            </Card>
            <Card title="Management pack" right={<button onClick={printPack} style={{ ...btnPrimary, padding: '6px 12px', minHeight: 36 }}>🖨 Open & print</button>}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={packMonth} onChange={(e) => setPackMonth(e.target.value)} style={{ ...inputStyle, width: narrow ? '100%' : 180, minHeight: 40 }} aria-label="Pack month">
                  {data.monthOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <span style={{ fontSize: 12, color: C.textDim }}>cash · P&L · margin · debtors · BAS · exceptions · dates</span>
              </div>
            </Card>
          </div>
        </div>
      )}

      {!data.loading && tab === 'margin' && <MarginTab data={data} narrow={narrow} who={who} />}
      {!data.loading && tab === 'cashflow' && <CashflowTab data={data} narrow={narrow} who={who} showToast={showToast} />}
      {!data.loading && tab === 'debtors' && <DebtorsTab data={data} narrow={narrow} who={who} showToast={showToast} />}
      {!data.loading && tab === 'compliance' && <ComplianceTab data={data} narrow={narrow} who={who} showToast={showToast} />}
      {!data.loading && tab === 'close' && <CloseTab data={data} narrow={narrow} who={who} showToast={showToast} goTab={goTab} />}
      {!data.loading && tab === 'receipts' && <ReceiptsTab data={data} narrow={narrow} who={who} showToast={showToast} />}
      {!data.loading && tab === 'pnl' && <PnlTab data={data} narrow={narrow} who={who} showToast={showToast} />}
      {!data.loading && tab === 'exceptions' && <ExceptionsTab data={data} narrow={narrow} lastOk={lastOk} />}
      {!data.loading && tab === 'transactions' && <TransactionsTab data={data} narrow={narrow} showToast={showToast} />}
      {/* Bottom room so the floating help bubble never sits on the Ask button (phone). */}
      {tab === 'ask' && <div style={{ paddingBottom: narrow ? 76 : 0 }}><Card title="Ask the books"><BooksAsk disabled={connect.state === 'not_connected'} /></Card></div>}
    </div>
  );
}
