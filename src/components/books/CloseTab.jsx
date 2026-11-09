import { useMemo, useState } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary, btnSmall, btnSecondary } from '../../theme';
import { Badge, Modal } from '../index';
import { Card, Num, CsvButton } from './BooksBits';
import { closeChecklist, closeableMonths } from '../../utils/booksClose';
import { monthLabel } from '../../utils/books';
import { fmtDateTime } from '../../utils/dates';

// Month-end close: live counts of what is still open, then "Close month"
// locks it in books_month_close (who / when / the counts). Re-open is logged
// with a reason.

export function CloseTab({ data, narrow, who, showToast, goTab }) {
  const { transactions, receipts, tsLite: timesheets, headers, invoices, closes, today, patch, monthOpts } = data;
  const months = useMemo(() => {
    const list = closeableMonths(transactions, closes, today);
    const have = new Set(list.map((m) => m.month));
    for (const o of monthOpts.slice(1, 4)) if (!have.has(o.value)) list.push({ month: o.value, close: closes.find((c) => String(c.month).slice(0, 7) === o.value) || null, closed: false });
    return list.sort((a, b) => b.month.localeCompare(a.month));
  }, [transactions, closes, today, monthOpts]);
  const [month, setMonth] = useState(() => months[0]?.month || monthOpts[1]?.value);
  const [reopen, setReopen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const check = useMemo(() => closeChecklist({ month, transactions, receipts, timesheets, headers, invoices }), [month, transactions, receipts, timesheets, headers, invoices]);
  const state = months.find((m) => m.month === month);
  const closed = !!state?.closed;

  const refresh = async () => { const { data: fresh } = await supabase.from('books_month_close').select('*'); patch({ closes: fresh || closes }); };
  const closeMonth = async () => {
    setBusy(true);
    const now = new Date().toISOString();
    const prev = state?.close?.history || [];
    const { error } = await supabase.from('books_month_close').upsert([{
      month: `${month}-01`, closed_by: who || null, closed_at: now, checklist: check, reopened_by: null, reopened_at: null, reopen_reason: null,
      history: [...prev, { action: 'closed', by: who || null, at: now, blocking: check.blocking }],
    }], { onConflict: 'month' });
    if (error) showToast?.(error.message, 'error'); else { showToast?.(`${monthLabel(month)} closed.`, 'success'); await refresh(); }
    setBusy(false);
  };
  const reopenMonth = async () => {
    if (!reason.trim()) { showToast?.('Give a reason.', 'error'); return; }
    setBusy(true);
    const now = new Date().toISOString();
    const prev = state?.close?.history || [];
    const { error } = await supabase.from('books_month_close').update({ reopened_by: who || null, reopened_at: now, reopen_reason: reason.trim(), history: [...prev, { action: 'reopened', by: who || null, at: now, reason: reason.trim() }] }).eq('month', `${month}-01`);
    if (error) showToast?.(error.message, 'error'); else { showToast?.(`${monthLabel(month)} re-opened.`, 'success'); setReopen(false); setReason(''); await refresh(); }
    setBusy(false);
  };

  const csv = check.items.map((i) => ({ 'Check': i.label, 'Count': i.count, 'Amount': i.amount === null ? '' : i.amount.toFixed(2), 'Blocks close': i.soft ? 'no' : i.count > 0 ? 'yes' : 'clear' }));

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ ...inputStyle, width: narrow ? '100%' : 200, minHeight: 42 }} aria-label="Month">
          {months.map((m) => <option key={m.month} value={m.month}>{monthLabel(m.month)}{m.closed ? ' · closed' : ''}</option>)}
        </select>
        {closed ? <Badge label={`Closed ${fmtDateTime(state.close.closed_at)} · ${state.close.closed_by || ''}`} color="green" /> : check.ready ? <Badge label="Ready to close" color="green" /> : <Badge label={`${check.blocking} open item${check.blocking === 1 ? '' : 's'}`} color="yellow" />}
        <span style={{ marginLeft: 'auto' }}><CsvButton rows={csv} filename={`close-${month}.csv`} /></span>
      </div>

      <Card title={`Checklist · ${monthLabel(month)}`}>
        <div style={{ display: 'grid', gap: 6 }}>
          {check.items.map((i) => {
            const icon = <span style={{ fontSize: 16, lineHeight: 1 }}>{i.count === 0 ? '✅' : i.soft ? '◽' : '⚠️'}</span>;
            const count = <span style={{ fontFamily: MONO, fontSize: 14, color: i.count ? (i.soft ? C.textMuted : '#fde047') : '#86efac' }}>{i.count}</span>;
            const amt = i.amount !== null && i.count ? <Num v={i.amount} size={12} color={C.textMuted} /> : null;
            const open = i.count > 0 && goTab ? <button onClick={() => goTab(i.tab)} style={{ ...btnSmall, minHeight: 32, padding: '4px 9px' }}>Open →</button> : null;
            return narrow ? (
              <div key={i.key} style={{ display: 'grid', gap: 6, background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.md, padding: '9px 12px' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{icon}<span style={{ fontSize: 13, color: C.text, flex: 1, minWidth: 0 }}>{i.label}</span>{count}</div>
                {(amt || open || i.soft) && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, paddingLeft: 24 }}>
                    <span style={{ fontSize: 11, color: C.textDim }}>{amt}{i.soft ? <span style={{ marginLeft: amt ? 6 : 0 }}>does not block</span> : null}</span>{open}
                  </div>
                )}
              </div>
            ) : (
              <div key={i.key} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto auto', gap: 10, alignItems: 'center', background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.md, padding: '9px 12px' }}>
                {icon}
                <span style={{ fontSize: 13, color: C.text, minWidth: 0 }}>{i.label}{i.soft && <span style={{ color: C.textDim, fontSize: 11, marginLeft: 6 }}>does not block</span>}</span>
                <span style={{ fontSize: 12, color: C.textDim, minWidth: 90, textAlign: 'right' }}>{amt}</span>
                <span style={{ minWidth: 28, textAlign: 'right' }}>{count}</span>
                <span style={{ minWidth: 70, textAlign: 'right' }}>{open}</span>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: C.textDim }}>{check.spend_count} spend lines this month</span>
          {closed
            ? <button onClick={() => setReopen(true)} style={{ ...btnSecondary, minHeight: 38 }}>Re-open month</button>
            : <button onClick={closeMonth} disabled={busy} style={{ ...btnPrimary, minHeight: 38, opacity: busy ? 0.6 : 1 }}>{busy ? '…' : check.ready ? 'Close month' : 'Close month anyway'}</button>}
        </div>
      </Card>

      {state?.close && (
        <Card title="History">
          {(state.close.history || []).slice().reverse().map((h, i) => (
            <div key={i} style={{ fontSize: 12, color: C.textMuted, padding: '4px 0', borderBottom: `1px solid ${C.border}`, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: MONO }}>{fmtDateTime(h.at)}</span>
              <Badge label={h.action} color={h.action === 'closed' ? 'green' : 'yellow'} size="sm" />
              <span>{h.by}</span>
              {h.reason && <span style={{ color: C.text }}>— {h.reason}</span>}
              {h.action === 'closed' && h.blocking > 0 && <span style={{ color: '#fde047' }}>with {h.blocking} open item{h.blocking === 1 ? '' : 's'}</span>}
            </div>
          ))}
        </Card>
      )}

      {reopen && (
        <Modal title={`Re-open ${monthLabel(month)}`} onClose={() => setReopen(false)} dismissible width={440}>
          <div style={{ display: 'grid', gap: 10 }}>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? (logged)" style={{ ...inputStyle, minHeight: 42 }} aria-label="Reason" autoFocus />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setReopen(false)} style={btnSecondary}>Cancel</button>
              <button onClick={reopenMonth} disabled={busy || !reason.trim()} style={{ ...btnPrimary, opacity: busy || !reason.trim() ? 0.6 : 1 }}>Re-open</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
