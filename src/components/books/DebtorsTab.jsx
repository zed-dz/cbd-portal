import { useMemo, useState } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary, btnSmall, btnSecondary } from '../../theme';
import { Badge, Modal, EmptyState } from '../index';
import { Card, Stat, Num, CsvButton, AgeingBuckets } from './BooksBits';
import { fmtMoney, daysOverdue, isOurs, dsoDays as dso } from '../../utils/books';
import { fmtDate, fmtDateTime } from '../../utils/dates';

// Debtors you can act on: aged list, Chase (email through the office path),
// promise-to-pay, chase log, DSO.

export function DebtorsTab({ data, narrow, who, showToast }) {
  const { openItems, chases, transactions, today, ageing, ourNumbers, clients, patch } = data;
  const debtors = useMemo(() => openItems.filter((o) => o.item_type === 'ACCREC'), [openItems]);
  const byItem = useMemo(() => { const m = new Map(); for (const c of chases) { if (!m.has(c.open_item_xero_id)) m.set(c.open_item_xero_id, []); m.get(c.open_item_xero_id).push(c); } return m; }, [chases]);
  const [sel, setSel] = useState(null);           // open item being chased
  const [mode, setMode] = useState('chase');      // chase | promise
  const [to, setTo] = useState(''); const [subject, setSubject] = useState(''); const [body, setBody] = useState('');
  const [pDate, setPDate] = useState(''); const [pAmt, setPAmt] = useState(''); const [pNote, setPNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('all');
  const total = debtors.reduce((s, d) => s + (Number(d.amount_due) || 0), 0);
  const overdue = debtors.filter((d) => daysOverdue(d.due_date, today) > 0);
  const dsoDays = useMemo(() => dso(openItems, transactions, today), [openItems, transactions, today]);

  const clientFor = (d) => clients.find((c) => (d.contact_id && c.xero_contact_id === d.contact_id) || c.name === d.contact_name) || null;
  const openChase = (d) => {
    const late = daysOverdue(d.due_date, today);
    const c = clientFor(d);
    setSel(d); setMode('chase'); setTo(c?.contact_email || '');
    setSubject(late > 0 ? `Overdue invoice ${d.number || ''} — ${fmtMoney(d.amount_due)} (${late} day${late === 1 ? '' : 's'} overdue)` : `Invoice ${d.number || ''} — ${fmtMoney(d.amount_due)} due ${fmtDate(d.due_date)}`);
    setBody([
      `A quick note about invoice ${d.number || ''}${d.issue_date ? ` dated ${fmtDate(d.issue_date)}` : ''}.`, '',
      late > 0 ? `The balance of ${fmtMoney(d.amount_due)} was due on ${fmtDate(d.due_date)} and is now ${late} day${late === 1 ? '' : 's'} overdue.` : `The balance of ${fmtMoney(d.amount_due)} is due on ${fmtDate(d.due_date)}.`, '',
      'Could you let us know when we can expect payment, or if anything on the invoice needs fixing on our side?', '', 'Thanks,',
    ].join('\n'));
    setPDate(''); setPAmt(String(d.amount_due || '')); setPNote('');
  };

  const sendChase = async () => {
    if (!sel) return;
    setBusy(true);
    const { data: r, error } = await supabase.functions.invoke('books-chase', { body: { xero_id: sel.xero_id, to: to.trim() || undefined, subject, body } });
    setBusy(false);
    if (error || !r?.ok) { showToast?.(r?.message || error?.message || 'Could not send.', 'error'); return; }
    showToast?.(`Chase sent to ${r.to}${r.via === 'demo' ? ' (demo — nothing emailed)' : ''}.`, 'success');
    const { data: fresh } = await supabase.from('books_chases').select('*').order('created_at', { ascending: false }).limit(1000);
    patch({ chases: fresh || chases });
    setSel(null);
  };

  const savePromise = async () => {
    if (!sel || !pDate) { showToast?.('Pick the promised date.', 'error'); return; }
    setBusy(true);
    const c = clientFor(sel);
    const { error } = await supabase.from('books_chases').insert([{
      open_item_xero_id: sel.xero_id, invoice_number: sel.number, contact_name: sel.contact_name, client_id: c?.id || null,
      kind: 'promise', promise_date: pDate, promise_amount: pAmt === '' ? null : Number(pAmt), note: pNote || null, status: 'noted', sent_by: who || null,
    }]);
    setBusy(false);
    if (error) { showToast?.(error.message, 'error'); return; }
    const { data: fresh } = await supabase.from('books_chases').select('*').order('created_at', { ascending: false }).limit(1000);
    patch({ chases: fresh || chases });
    showToast?.('Promise to pay noted.', 'success');
    setSel(null);
  };

  const list = debtors.filter((d) => filter === 'all' ? true : filter === 'overdue' ? daysOverdue(d.due_date, today) > 0 : filter === 'promised' ? (byItem.get(d.xero_id) || []).some((c) => c.kind === 'promise') : (byItem.get(d.xero_id) || []).length === 0)
    .sort((a, b) => daysOverdue(b.due_date, today) - daysOverdue(a.due_date, today));
  const csv = list.map((d) => { const log = byItem.get(d.xero_id) || []; const pr = log.find((c) => c.kind === 'promise'); const ch = log.filter((c) => c.kind === 'chase'); return {
    'Client': d.contact_name || '', 'Invoice': d.number || '', 'Issued': d.issue_date || '', 'Due': d.due_date || '', 'Days overdue': Math.max(0, daysOverdue(d.due_date, today)),
    'Total': Number(d.total || 0).toFixed(2), 'Owing': Number(d.amount_due || 0).toFixed(2), 'Chased': ch.length, 'Last chased': ch[0]?.created_at?.slice(0, 10) || '', 'Promised': pr?.promise_date || '', 'Promised $': pr?.promise_amount ?? '' }; });

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: narrow ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
        <Stat label="Owed to us" value={fmtMoney(total)} hint={`${debtors.length} open invoice${debtors.length === 1 ? '' : 's'}`} />
        <Stat label="Overdue" value={fmtMoney(overdue.reduce((s, d) => s + (Number(d.amount_due) || 0), 0))} tone={overdue.length ? 'out' : undefined} hint={`${overdue.length} invoice${overdue.length === 1 ? '' : 's'}`} />
        <Stat label="DSO" value={dsoDays === null ? '—' : `${dsoDays} days`} hint="receivables ÷ daily sales (90 d)" />
        <Stat label="Promised" value={fmtMoney(debtors.reduce((s, d) => { const p = (byItem.get(d.xero_id) || []).find((c) => c.kind === 'promise'); return s + (p ? Number(p.promise_amount ?? d.amount_due) || 0 : 0); }, 0))} hint="promise-to-pay noted" />
      </div>
      <Card title="By age"><AgeingBuckets buckets={ageing} /></Card>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {[['all', 'All'], ['overdue', 'Overdue'], ['unchased', 'Never chased'], ['promised', 'Promised']].map(([v, l]) => (
          <button key={v} onClick={() => setFilter(v)} style={{ ...btnSmall, minHeight: 34, background: filter === v ? C.accentSoft : btnSmall.background, color: filter === v ? '#fdba74' : C.text, borderColor: filter === v ? C.accentBorder : C.border }}>{l}</button>
        ))}
        <span style={{ marginLeft: 'auto' }}><CsvButton rows={csv} filename={`debtors-${today}.csv`} /></span>
      </div>

      {list.length === 0 ? <EmptyState icon="🤝" message="No open sales invoices match." /> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {list.map((d) => {
            const late = daysOverdue(d.due_date, today);
            const log = byItem.get(d.xero_id) || [];
            const chasesN = log.filter((c) => c.kind === 'chase').length;
            const promise = log.find((c) => c.kind === 'promise');
            const lastChase = log.find((c) => c.kind === 'chase');
            const ours = isOurs(d.number, ourNumbers);
            return (
              <div key={d.xero_id} style={{ background: C.card, border: `1px solid ${late > 30 ? 'rgba(239,68,68,0.35)' : C.border}`, borderRadius: R.md, padding: '10px 12px', display: 'grid', gap: 8, gridTemplateColumns: narrow ? '1fr' : '1fr auto', alignItems: 'center' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ color: C.text, fontWeight: 600, fontSize: 13, overflowWrap: 'anywhere' }}>{d.contact_name || '(no contact)'}</span>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: C.textMuted }}>{d.number || '—'}</span>
                    {d.is_demo && <Badge label="demo" color="purple" size="sm" />}
                    {ours && <Badge label="ours" color="blue" size="sm" />}
                    {promise && <Badge label={`promised ${fmtDate(promise.promise_date)}`} color={promise.promise_date < today ? 'red' : 'green'} size="sm" />}
                  </div>
                  <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span>due {fmtDate(d.due_date)}</span>
                    {late > 0 ? <span style={{ color: late > 30 ? '#fca5a5' : '#fde047', fontWeight: 600 }}>{late} d overdue</span> : <span style={{ color: '#86efac' }}>{late === 0 ? 'due today' : `in ${-late} d`}</span>}
                    <span>{chasesN ? `chased ${chasesN}× · last ${fmtDate(lastChase.created_at?.slice(0, 10))}` : 'never chased'}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: narrow ? 'space-between' : 'flex-end', flexWrap: 'wrap' }}>
                  <Num v={d.amount_due} bold size={15} />
                  <button onClick={() => openChase(d)} style={{ ...btnSmall, minHeight: 36 }}>Chase</button>
                  <button onClick={() => { openChase(d); setMode('promise'); }} style={{ ...btnSmall, minHeight: 36 }}>Promise</button>
                </div>
                {log.length > 0 && (
                  <div style={{ gridColumn: '1 / -1', fontSize: 11, color: C.textDim, display: 'grid', gap: 2 }}>
                    {log.slice(0, 3).map((c) => (
                      <div key={c.id} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: MONO }}>{fmtDateTime(c.created_at)}</span>
                        <span>{c.kind === 'chase' ? `chase → ${c.to_email}${c.status === 'failed' ? ' (failed)' : ''}` : c.kind === 'promise' ? `promise ${fmtDate(c.promise_date)} ${c.promise_amount != null ? fmtMoney(c.promise_amount) : ''} ${c.note || ''}` : c.note}</span>
                        <span style={{ color: C.textDim }}>· {c.sent_by}</span>
                      </div>
                    ))}
                    {log.length > 3 && <span>+{log.length - 3} more</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {sel && (
        <Modal title={mode === 'chase' ? `Chase ${sel.number || ''}` : `Promise to pay · ${sel.number || ''}`} onClose={() => setSel(null)} dismissible width={520}>
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ fontSize: 13, color: C.textMuted }}>{sel.contact_name} · owes <Num v={sel.amount_due} bold /> · {daysOverdue(sel.due_date, today) > 0 ? `${daysOverdue(sel.due_date, today)} d overdue` : `due ${fmtDate(sel.due_date)}`}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setMode('chase')} style={{ ...btnSmall, background: mode === 'chase' ? C.accentSoft : btnSmall.background }}>Email</button>
              <button onClick={() => setMode('promise')} style={{ ...btnSmall, background: mode === 'promise' ? C.accentSoft : btnSmall.background }}>Promise to pay</button>
            </div>
            {mode === 'chase' ? (
              <>
                <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="billing@client.com.au" style={{ ...inputStyle, minHeight: 42 }} aria-label="To" />
                <input value={subject} onChange={(e) => setSubject(e.target.value)} style={{ ...inputStyle, minHeight: 42 }} aria-label="Subject" />
                <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }} aria-label="Message" />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button onClick={() => setSel(null)} style={btnSecondary}>Cancel</button>
                  <button onClick={sendChase} disabled={busy || !to.trim()} style={{ ...btnPrimary, opacity: busy || !to.trim() ? 0.6 : 1 }}>{busy ? 'Sending…' : 'Send chase'}</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'grid', gap: 8, gridTemplateColumns: narrow ? '1fr' : '1fr 1fr' }}>
                  <input type="date" value={pDate} onChange={(e) => setPDate(e.target.value)} style={{ ...inputStyle, minHeight: 42 }} aria-label="Promised date" />
                  <input type="number" step="0.01" value={pAmt} onChange={(e) => setPAmt(e.target.value)} placeholder="Amount" style={{ ...inputStyle, minHeight: 42, fontFamily: MONO, textAlign: 'right' }} aria-label="Promised amount" />
                </div>
                <input value={pNote} onChange={(e) => setPNote(e.target.value)} placeholder="Who said it, how (phone, email)…" style={{ ...inputStyle, minHeight: 42 }} aria-label="Note" />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button onClick={() => setSel(null)} style={btnSecondary}>Cancel</button>
                  <button onClick={savePromise} disabled={busy || !pDate} style={{ ...btnPrimary, opacity: busy || !pDate ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save promise'}</button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
