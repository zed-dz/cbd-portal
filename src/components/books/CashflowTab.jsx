import { useMemo, useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, btnPrimary } from '../../theme';
import { Badge } from '../index';
import { Card, Stat, Num, Rows, CsvButton, MiniInput, KV } from './BooksBits';
import { rollForwardBalance, daysLateByContact, weeklyPayroll, recurringBills, buildForecast, forecastCSVRows } from '../../utils/booksForecast';
import { upcomingObligations, complianceEstimates } from '../../utils/booksCompliance';
import { shiftMarginRows } from '../../utils/booksMargin';
import { fmtMoney } from '../../utils/books';
import { fmtDate } from '../../utils/dates';
import { saveSnapshot } from './useBooksData';

// 13-week cash forecast. The only typed input is the bank balance as at a
// date (Xero's granular scopes give bank LINES, not balances); everything else
// is derived from the synced rows and the portal's own timesheets.

export function CashflowTab({ data, narrow, who, showToast }) {
  const { settings, transactions, openItems, invoices, timesheets, workers, clients, rateCards, roleRates, config, today, bas, patch } = data;
  const [bal, setBal] = useState(settings?.bank_balance ?? '');
  const [balDate, setBalDate] = useState(settings?.bank_balance_date || today);
  const [saving, setSaving] = useState(false);
  const [openWeek, setOpenWeek] = useState(null);
  useEffect(() => { setBal(settings?.bank_balance ?? ''); setBalDate(settings?.bank_balance_date || today); }, [settings, today]);

  const liveTx = useMemo(() => transactions.filter((t) => t.is_cash && ['AUTHORISED', 'PAID'].includes(String(t.status || 'AUTHORISED').toUpperCase())), [transactions]);
  const opening = useMemo(() => rollForwardBalance(settings?.bank_balance, settings?.bank_balance_date, liveTx, today), [settings, liveTx, today]);

  // Days late per client from the portal's own paid invoices (issue/due → paid).
  const lateMap = useMemo(() => daysLateByContact((invoices || []).filter((i) => i.fully_paid_on && i.due_date).map((i) => ({ contact: i.client, due_date: i.due_date, paid_date: i.fully_paid_on }))), [invoices]);

  // Payroll pattern: wage lines in the bank, else timesheet pay / weeks in range.
  const tsWeekly = useMemo(() => {
    const rows = shiftMarginRows({ timesheets, workers, clients, rateCards, roleRates, config });
    if (!rows.length) return 0;
    const weeks = new Set(rows.map((r) => r.week)).size || 1;
    return Math.round((rows.reduce((s, r) => s + r.pay, 0) / weeks) * 100) / 100;
  }, [timesheets, workers, clients, rateCards, roleRates, config]);
  const payroll = useMemo(() => weeklyPayroll(liveTx, today, tsWeekly), [liveTx, today, tsWeekly]);
  const bills = useMemo(() => recurringBills(liveTx, today), [liveTx, today]);
  const grossPay4w = useMemo(() => payroll.weekly * 4, [payroll]);
  const estimates = useMemo(() => complianceEstimates({ bas, grossPay: grossPay4w, settings: settings || {} }), [bas, grossPay4w, settings]);
  const obligations = useMemo(() => upcomingObligations(today, settings || {}, estimates, 4), [today, settings, estimates]);
  const receivables = useMemo(() => openItems.filter((o) => o.item_type === 'ACCREC'), [openItems]);
  const fc = useMemo(() => buildForecast({ today, opening, openItems: receivables, lateMap, payroll, bills, obligations, weeks: 13 }), [today, opening, receivables, lateMap, payroll, bills, obligations]);

  useEffect(() => { saveSnapshot('forecast', { ...fc, payroll, bills: bills.map((b) => ({ name: b.name, cadence: b.cadence, amount: b.amount })), as_at: today }, who); }, [fc, payroll, bills, today, who]);

  const saveBalance = async () => {
    setSaving(true);
    const v = bal === '' ? null : Number(bal);
    const { error } = await supabase.from('books_settings').update({ bank_balance: v, bank_balance_date: v === null ? null : balDate, updated_by: who || null, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) showToast?.(error.message, 'error'); else { patch({ settings: { ...settings, bank_balance: v, bank_balance_date: v === null ? null : balDate } }); showToast?.('Bank balance saved.', 'success'); }
    setSaving(false);
  };

  // One vertical scale for bars (weekly in / out) and the closing-balance line.
  const W = narrow ? 328 : 720; const H = 150; const PAD = 10;
  const closings = fc.weeks.map((w) => (w.closing === null ? 0 : w.closing));
  const maxFlow = Math.max(1, ...fc.weeks.map((w) => Math.max(w.receipts, w.out)));
  const sMin = Math.min(0, ...closings); const sMax = Math.max(maxFlow, ...closings);
  const span = sMax - sMin || 1;
  const X = (i) => PAD + (i * (W - PAD * 2)) / Math.max(1, fc.weeks.length - 1);
  const Y = (v) => PAD + ((sMax - v) / span) * (H - PAD * 2);
  const pl = { points: fc.weeks.map((w, i) => `${X(i).toFixed(1)},${Y(w.closing === null ? 0 : w.closing).toFixed(1)}`).join(' '), zeroY: Y(0) };
  const cols = [
    { key: 'week', label: 'Week', render: (w) => <span style={{ fontWeight: 600 }}>{fmtDate(w.week)}</span> },
    { key: 'receipts', label: 'In', align: 'right', render: (w) => <Num v={w.receipts} color="#86efac" /> },
    { key: 'payroll', label: 'Payroll', align: 'right', render: (w) => <Num v={w.payroll} /> },
    { key: 'bills', label: 'Bills', align: 'right', render: (w) => <Num v={w.bills} /> },
    { key: 'ato', label: 'ATO · super', align: 'right', render: (w) => <Num v={w.ato} /> },
    { key: 'net', label: 'Net', align: 'right', render: (w) => <Num v={w.net} signed /> },
    { key: 'closing', label: 'Closing', align: 'right', render: (w) => w.closing === null ? <span style={{ color: C.textDim }}>—</span> : <Num v={w.closing} bold color={w.closing < 0 ? '#fca5a5' : undefined} /> },
  ];
  const wk = fc.weeks.find((w) => w.week === openWeek);

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: narrow ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
        <Stat label="Bank today" value={opening === null ? '—' : fmtMoney(opening)} hint={opening === null ? 'type the balance below' : `from ${fmtDate(settings?.bank_balance_date)} + bank lines`} />
        <Stat label="In · 13 wks" value={fmtMoney(fc.total_in)} tone="in" />
        <Stat label="Out · 13 wks" value={fmtMoney(fc.total_out)} tone="out" />
        <Stat label="Runway" value={fc.runway_week ? fmtDate(fc.runway_week) : opening === null ? '—' : '13+ wks'} hint={fc.runway_week ? 'first week below zero' : fc.lowest ? `low ${fmtMoney(fc.lowest.closing)}` : undefined} />
      </div>

      <Card title="Closing balance · next 13 weeks" right={<CsvButton rows={forecastCSVRows(fc)} filename={`cashflow-13w-${today}.csv`} />}>
        <div style={{ overflowX: 'auto' }}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Closing balance by week" style={{ display: 'block', maxWidth: '100%' }}>
            <line x1={0} x2={W} y1={pl.zeroY} y2={pl.zeroY} stroke={C.borderStrong} strokeDasharray="4 4" />
            {fc.weeks.map((w, i) => {
              const x = X(i); const bw = Math.max(4, (W - PAD * 2) / fc.weeks.length - 6);
              return (
                <g key={w.week}>
                  <rect x={x - bw / 2} y={Y(w.receipts)} width={bw / 2 - 1} height={Math.max(0, Y(0) - Y(w.receipts))} fill="#22c55e" opacity={0.4} />
                  <rect x={x} y={Y(w.out)} width={bw / 2 - 1} height={Math.max(0, Y(0) - Y(w.out))} fill="#ef4444" opacity={0.4} />
                </g>
              );
            })}
            {opening !== null && <polyline points={pl.points} fill="none" stroke="#38bdf8" strokeWidth={2} />}
            {opening !== null && fc.weeks.map((w, i) => <circle key={w.week} cx={X(i)} cy={Y(w.closing)} r={3} fill={w.closing < 0 ? '#fca5a5' : '#38bdf8'} />)}
          </svg>
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 11, color: C.textMuted, marginTop: 6, flexWrap: 'wrap' }}>
          <span><span style={{ color: '#38bdf8' }}>■</span> closing balance</span><span><span style={{ color: '#22c55e' }}>■</span> in</span><span><span style={{ color: '#ef4444' }}>■</span> out</span>
          <span style={{ color: C.textDim }}>· {fmtDate(fc.weeks[0]?.week)} → {fmtDate(fc.weeks[12]?.end)}</span>
        </div>
      </Card>

      <Card title="Week by week">
        <Rows cols={cols} rows={fc.weeks} narrow={narrow} keyOf={(w) => w.week} onRow={(w) => setOpenWeek(openWeek === w.week ? null : w.week)} />
        {wk && (
          <div style={{ marginTop: 10, background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.md, padding: '8px 12px' }}>
            <div style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO, marginBottom: 6 }}>WEEK OF {fmtDate(wk.week).toUpperCase()}</div>
            {wk.items.length === 0 ? <div style={{ fontSize: 12, color: C.textDim }}>Only the payroll pattern this week.</div> : wk.items.map((it, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '3px 0' }}>
                <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><Badge label={it.kind === 'receipt' ? 'in' : it.kind === 'ato' ? 'ATO' : 'bill'} color={it.kind === 'receipt' ? 'green' : it.kind === 'ato' ? 'yellow' : 'gray'} size="sm" /> {it.label} <span style={{ color: C.textDim }}>{fmtDate(it.date)}</span></span>
                <Num v={it.amount} signed />
              </div>
            ))}
          </div>
        )}
      </Card>

      <div style={{ display: 'grid', gap: 14, gridTemplateColumns: narrow ? '1fr' : '1fr 1fr' }}>
        <Card title="Inputs">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
            <MiniInput value={bal} onChange={setBal} width={narrow ? 130 : 150} step="0.01" placeholder="Bank balance" ariaLabel="Bank balance" />
            <MiniInput type="date" value={balDate} onChange={setBalDate} width={narrow ? 150 : 160} ariaLabel="Balance as at" />
            <button onClick={saveBalance} disabled={saving} style={{ ...btnPrimary, minHeight: 36, padding: '6px 14px' }}>{saving ? '…' : 'Save'}</button>
          </div>
          <KV k="Payroll / week" v={<Num v={payroll.weekly} />} hint={payroll.source === 'bank' ? `median of ${payroll.weeks} wage weeks` : payroll.source === 'timesheets' ? 'from approved timesheets' : 'no pattern yet'} />
          <KV k="Open sales invoices" v={<Num v={receivables.reduce((s, o) => s + (Number(o.amount_due) || 0), 0)} />} hint={`${receivables.length} · timed by each client's days-to-pay`} />
          <KV k="Clients with pay history" v={<span style={{ fontFamily: MONO }}>{lateMap.size}</span>} hint="others assumed 7 days late" />
          <KV k="ATO · super in horizon" v={<Num v={obligations.filter((o) => o.amount !== null).reduce((s, o) => s + Math.max(0, Number(o.amount) || 0), 0)} />} hint="estimates" />
        </Card>
        <Card title="Recurring bills found" right={<span style={{ fontFamily: MONO, fontSize: 11, color: C.textMuted }}>{bills.length}</span>}>
          {bills.length === 0 ? <div style={{ color: C.textDim, fontSize: 13 }}>No supplier repeats on a steady cadence yet.</div> : bills.slice(0, 12).map((b) => (
            <KV key={b.name} k={b.name} hint={b.cadence === 7 ? 'weekly' : b.cadence === 14 ? 'fortnightly' : 'monthly'} v={<span><Num v={b.amount} /> <span style={{ fontSize: 11, color: C.textDim }}>next {fmtDate(b.occurrences[0])}</span></span>} />
          ))}
          {bills.length > 12 && <div style={{ fontSize: 11, color: C.textDim, marginTop: 6 }}>+{bills.length - 12} more</div>}
        </Card>
      </div>
    </div>
  );
}
