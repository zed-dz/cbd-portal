import { useMemo, useState, useRef } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary, btnSmall, btnSecondary, btnDanger } from '../../theme';
import { Badge, Modal, Spinner, EmptyState } from '../index';
import { Stat, Num, CsvButton, Seg } from './BooksBits';
import { suggestMatches, suggestAccountCode, receiptsCSVRows } from '../../utils/booksClose';
import { fmtMoney } from '../../utils/books';
import { fmtDate } from '../../utils/dates';

// Receipts inbox: upload → books-receipt reads vendor/date/total/GST (Pixtral
// chain) → suggest the uncoded bank line (amount ±2 %, date ±5 d) + an account
// code → admin confirms. Files live in the private books-receipts bucket under
// <auth uid>/.

const BUCKET = 'books-receipts';
const STATUS_COLOR = { new: 'yellow', matched: 'blue', confirmed: 'green', rejected: 'gray' };

export function ReceiptsTab({ data, narrow, who, showToast }) {
  const { receipts, transactions, accounts, patch } = data;
  const [filter, setFilter] = useState('open');
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(null);
  const [edit, setEdit] = useState({});
  const [url, setUrl] = useState(null);
  const fileRef = useRef(null);

  const list = useMemo(() => receipts.filter((r) => filter === 'all' ? true : filter === 'open' ? ['new', 'matched'].includes(r.status) : r.status === filter), [receipts, filter]);
  const liveTx = useMemo(() => transactions.filter((t) => t.is_cash && ['AUTHORISED', 'PAID'].includes(String(t.status || 'AUTHORISED').toUpperCase())), [transactions]);
  const matchedIds = useMemo(() => new Set(receipts.filter((r) => r.matched_xero_id && r.status !== 'rejected' && r.id !== sel?.id).map((r) => r.matched_xero_id)), [receipts, sel]);
  const cands = useMemo(() => (sel ? suggestMatches({ ...sel, ...edit }, liveTx.filter((t) => !matchedIds.has(t.xero_id))) : []), [sel, edit, liveTx, matchedIds]);
  const matched = useMemo(() => (edit.matched_xero_id ? liveTx.find((t) => t.xero_id === edit.matched_xero_id) : null), [edit.matched_xero_id, liveTx]);
  const codeHint = useMemo(() => (sel ? suggestAccountCode({ ...sel, ...edit }, liveTx, matched) : null), [sel, edit, liveTx, matched]);

  const refresh = async () => { const { data: fresh } = await supabase.from('books_receipts').select('*').order('uploaded_at', { ascending: false }).limit(500); patch({ receipts: fresh || receipts }); return fresh || []; };

  const upload = async (files) => {
    if (!files?.length) return;
    setBusy(true);
    const { data: u } = await supabase.auth.getUser();
    const uid = u?.user?.id;
    if (!uid) { showToast?.('Sign in again.', 'error'); setBusy(false); return; }
    let read = 0;
    for (const f of files.slice(0, 10)) {
      const ext = (f.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `${uid}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, f, { contentType: f.type || undefined, upsert: false });
      if (upErr) { showToast?.(`${f.name}: ${upErr.message}`, 'error'); continue; }
      const { data: r, error } = await supabase.functions.invoke('books-receipt', { body: { path } });
      if (error || (!r?.ok && !r?.receipt_id)) showToast?.(`${f.name}: ${r?.message || error?.message || 'could not read'}`, 'error');
      else read += 1;
    }
    const fresh = await refresh();
    setBusy(false);
    if (read) showToast?.(`${read} receipt${read === 1 ? '' : 's'} read.`, 'success');
    if (fresh[0]) open(fresh[0]);
  };

  const open = async (r) => {
    setSel(r);
    setEdit({ vendor: r.vendor || '', receipt_date: r.receipt_date || '', total: r.total ?? '', gst: r.gst ?? '', account_code: r.account_code || '', matched_xero_id: r.matched_xero_id || '' });
    setUrl(null);
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(r.path, 600);
    setUrl(data?.signedUrl || null);
  };

  const save = async (status) => {
    if (!sel) return;
    setBusy(true);
    const row = {
      vendor: edit.vendor || null, receipt_date: edit.receipt_date || null, total: edit.total === '' ? null : Number(edit.total), gst: edit.gst === '' ? null : Number(edit.gst),
      account_code: edit.account_code || null, matched_xero_id: edit.matched_xero_id || null,
      status: status || (edit.matched_xero_id ? 'matched' : 'new'),
      confirmed_by: status === 'confirmed' ? who || null : sel.confirmed_by, confirmed_at: status === 'confirmed' ? new Date().toISOString() : sel.confirmed_at,
    };
    const { error } = await supabase.from('books_receipts').update(row).eq('id', sel.id);
    if (error) showToast?.(error.message, 'error'); else { showToast?.(status === 'confirmed' ? 'Receipt confirmed.' : status === 'rejected' ? 'Receipt rejected.' : 'Saved.', 'success'); await refresh(); setSel(null); }
    setBusy(false);
  };
  const remove = async () => {
    if (!sel) return;
    setBusy(true);
    await supabase.storage.from(BUCKET).remove([sel.path]);
    const { error } = await supabase.from('books_receipts').delete().eq('id', sel.id);
    if (error) showToast?.(error.message, 'error'); else { await refresh(); setSel(null); }
    setBusy(false);
  };

  const counts = { new: receipts.filter((r) => r.status === 'new').length, matched: receipts.filter((r) => r.status === 'matched').length, confirmed: receipts.filter((r) => r.status === 'confirmed').length };
  const spendNoReceipt = useMemo(() => { const m = new Set(receipts.filter((r) => r.matched_xero_id && r.status !== 'rejected').map((r) => r.matched_xero_id)); return liveTx.filter((t) => t.direction === 'out' && t.kind === 'spend' && !m.has(t.xero_id)).length; }, [receipts, liveTx]);

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: narrow ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
        <Stat label="To review" value={String(counts.new + counts.matched)} hint={`${counts.new} new · ${counts.matched} matched`} />
        <Stat label="Confirmed" value={String(counts.confirmed)} tone="in" />
        <Stat label="Spend with no receipt" value={String(spendNoReceipt)} hint="bank lines, 13 months" />
        <div style={{ display: 'flex', alignItems: 'stretch' }}>
          <button onClick={() => fileRef.current?.click()} disabled={busy} style={{ ...btnPrimary, width: '100%', minHeight: 56, opacity: busy ? 0.7 : 1 }}>{busy ? 'Reading…' : '📷 Add receipt'}</button>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple hidden onChange={(e) => { const picked = Array.from(e.target.files || []); e.target.value = ''; upload(picked); }} aria-label="Upload receipt" />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Seg options={[['open', 'To review'], ['confirmed', 'Confirmed'], ['rejected', 'Rejected'], ['all', 'All']]} value={filter} onChange={setFilter} />
        <span style={{ marginLeft: 'auto' }}><CsvButton rows={receiptsCSVRows(list)} filename="receipts.csv" /></span>
      </div>

      {list.length === 0 ? <EmptyState icon="🧾" message={filter === 'open' ? 'Nothing to review. Add a receipt photo or PDF.' : 'No receipts here.'} /> : (
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: narrow ? '1fr' : 'repeat(auto-fill, minmax(300px, 1fr))' }}>
          {list.map((r) => (
            <button key={r.id} onClick={() => open(r)} style={{ textAlign: 'left', background: C.card, border: `1px solid ${C.border}`, borderRadius: R.md, padding: '10px 12px', cursor: 'pointer', display: 'grid', gap: 4, color: C.text }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <span style={{ fontWeight: 600, fontSize: 13, overflowWrap: 'anywhere', minWidth: 0 }}>{r.vendor || <span style={{ color: '#fde047' }}>vendor not read</span>}</span>
                <Num v={r.total} bold />
              </div>
              <div style={{ fontSize: 12, color: C.textMuted, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Badge label={r.status} color={STATUS_COLOR[r.status] || 'gray'} size="sm" />
                <span style={{ fontFamily: MONO }}>{r.receipt_date ? fmtDate(r.receipt_date) : 'no date'}</span>
                <span>GST {fmtMoney(r.gst)}</span>
                {r.account_code && <span style={{ fontFamily: MONO }}>{r.account_code}</span>}
                {r.is_demo && <Badge label="demo" color="purple" size="sm" />}
              </div>
            </button>
          ))}
        </div>
      )}

      {sel && (
        <Modal title={sel.vendor || 'Receipt'} onClose={() => setSel(null)} dismissible width={640}>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: narrow ? '1fr' : '240px 1fr' }}>
            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.md, minHeight: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              {!url ? <Spinner /> : /\.pdf$/i.test(sel.path) ? <a href={url} target="_blank" rel="noreferrer" style={{ color: '#7dd3fc', fontSize: 13 }}>Open PDF ↗</a> : <img src={url} alt="receipt" style={{ maxWidth: '100%', maxHeight: 360, objectFit: 'contain' }} />}
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr' }}>
                <input value={edit.vendor} onChange={(e) => setEdit({ ...edit, vendor: e.target.value })} placeholder="Vendor" style={{ ...inputStyle, minHeight: 40, gridColumn: '1 / -1' }} aria-label="Vendor" />
                <input type="date" value={edit.receipt_date} onChange={(e) => setEdit({ ...edit, receipt_date: e.target.value })} style={{ ...inputStyle, minHeight: 40 }} aria-label="Date" />
                <input type="number" step="0.01" value={edit.total} onChange={(e) => setEdit({ ...edit, total: e.target.value })} placeholder="Total" style={{ ...inputStyle, minHeight: 40, fontFamily: MONO, textAlign: 'right' }} aria-label="Total" />
                <input type="number" step="0.01" value={edit.gst} onChange={(e) => setEdit({ ...edit, gst: e.target.value })} placeholder="GST" style={{ ...inputStyle, minHeight: 40, fontFamily: MONO, textAlign: 'right' }} aria-label="GST" />
                <select value={edit.account_code} onChange={(e) => setEdit({ ...edit, account_code: e.target.value })} style={{ ...inputStyle, minHeight: 40 }} aria-label="Account">
                  <option value="">Account…</option>
                  {accounts.filter((a) => ['EXPENSE', 'DIRECTCOSTS', 'OVERHEADS', 'OTHEREXPENSE', 'FIXED', 'CURRENT'].includes(String(a.type || '').toUpperCase())).sort((a, b) => a.code.localeCompare(b.code)).map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
                </select>
              </div>
              {codeHint && !edit.account_code && <button onClick={() => setEdit({ ...edit, account_code: codeHint.code })} style={{ ...btnSmall, justifySelf: 'start' }}>Use {codeHint.code} {codeHint.name} <span style={{ color: C.textDim }}>· {codeHint.why}</span></button>}
              <div style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO, letterSpacing: 0.8 }}>MATCHING BANK LINE</div>
              {matched && (
                <div style={{ background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.35)', borderRadius: R.md, padding: '8px 10px', fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{fmtDate(matched.txn_date)} · {matched.contact_name || matched.description || '—'} <span style={{ color: C.textDim }}>{matched.account_name || 'uncoded'}</span></span>
                  <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Num v={matched.total} /><button onClick={() => setEdit({ ...edit, matched_xero_id: '' })} style={{ ...btnSmall, padding: '2px 8px' }}>✕</button></span>
                </div>
              )}
              {!matched && (cands.length === 0 ? <div style={{ fontSize: 12, color: C.textDim }}>No bank line within ±2 % and ±5 days{edit.total ? '' : ' — type the total first'}.</div> : cands.map((t) => (
                <button key={t.xero_id} onClick={() => setEdit({ ...edit, matched_xero_id: t.xero_id, account_code: edit.account_code || t.account_code || '' })} style={{ ...btnSmall, textAlign: 'left', display: 'flex', justifyContent: 'space-between', gap: 8, minHeight: 38 }}>
                  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{fmtDate(t.txn_date)} · {t.contact_name || t.description || '—'} {t.vendor_hit && <Badge label="vendor" color="green" size="sm" />}{!t.account_code && <Badge label="uncoded" color="yellow" size="sm" />}</span>
                  <Num v={t.total} />
                </button>
              )))}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap', marginTop: 4 }}>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button onClick={remove} disabled={busy} style={btnDanger}>Delete</button>
                  <button onClick={() => save('rejected')} disabled={busy} style={btnSecondary}>Reject</button>
                </span>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => save()} disabled={busy} style={btnSecondary}>Save</button>
                  <button onClick={() => save('confirmed')} disabled={busy} style={btnPrimary}>Confirm</button>
                </span>
              </div>
              <div style={{ fontSize: 11, color: C.textDim }}>{sel.via ? `read by ${sel.via}` : 'not read'}{sel.extracted?.confidence != null ? ` · confidence ${(sel.extracted.confidence * 100).toFixed(0)}%` : ''}{sel.abn ? ` · ABN ${sel.abn}` : ''}</div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
