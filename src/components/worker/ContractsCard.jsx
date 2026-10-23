import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { fmtDateTime } from '../../utils/dates';
import { Badge, Modal } from '../index';
import { SignaturePad } from '../ui/SignaturePad';
import { signatureProblem } from '../../utils/signatures';
import { addAdminNotification } from '../../utils/notify';

// Your contract (worker app, 2026-10-23): shown at the top of the Documents tab.
// Read the full wording, tick, type your name, draw your signature, sign.
// The database stamps time, IP, device and a hash of the wording, and refuses
// any change to a signed contract. Opening it marks it "viewed" for the office.

export function ContractsCard({ currentWorker, showToast }) {
  const [rows, setRows] = useState([]);
  const [reading, setReading] = useState(null);
  const load = useCallback(async () => {
    const { data } = await supabase.from('worker_contracts').select('id, title, body, status, sent_at, viewed_at, signed_at, signed_name, template_version').eq('worker_id', currentWorker.id).neq('status', 'withdrawn').order('created_at', { ascending: false });
    setRows(data || []);
  }, [currentWorker.id]);
  useEffect(() => { load(); }, [load]);

  const open = async (c) => {
    setReading(c);
    if (c.status === 'sent') { await supabase.from('worker_contracts').update({ status: 'viewed' }).eq('id', c.id); load(); }
  };
  if (!rows.length) return null;
  const unsigned = rows.filter(r => r.status !== 'signed');
  return (
    <div data-area="your contract" style={{ display: 'grid', gap: 10 }}>
      {rows.map(c => (
        <div key={c.id} style={{ background: C.card, border: `1px solid ${c.status === 'signed' ? C.border : C.accentBorder}`, borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>📝 {c.title}</div>
              <div style={{ color: C.textDim, fontSize: 11.5, marginTop: 2 }}>Your employment contract{c.sent_at ? ` · sent ${fmtDateTime(c.sent_at)}` : ''}</div>
            </div>
            {c.status === 'signed' ? <Badge label={`Signed ${fmtDateTime(c.signed_at)}`} color="green" /> : <Badge label="Please read and sign" color="orange" />}
          </div>
          <div style={{ marginTop: 10 }}>
            <button onClick={() => open(c)} style={{ ...(c.status === 'signed' ? btnSmall : btnPrimary), minHeight: 40 }}>{c.status === 'signed' ? 'Open' : 'Read & sign →'}</button>
          </div>
        </div>
      ))}
      {unsigned.length > 0 && <div style={{ color: C.textMuted, fontSize: 12.5 }}>Read it when you have a quiet minute. The office sees when it is signed.</div>}
      {reading && <ContractReader contract={reading} currentWorker={currentWorker} showToast={showToast} onClose={() => setReading(null)} onSigned={() => { setReading(null); load(); }} />}
    </div>
  );
}

function ContractReader({ contract: c, currentWorker, showToast, onClose, onSigned }) {
  const [agree, setAgree] = useState(false);
  const [name, setName] = useState('');
  const [drawn, setDrawn] = useState('');
  const [busy, setBusy] = useState(false);
  const signed = c.status === 'signed';

  const sign = async () => {
    if (!agree) { showToast('Tick the box first.', 'error'); return; }
    if (name.trim().length < 3) { showToast('Type your full name to sign.', 'error'); return; }
    const problem = signatureProblem(drawn); if (problem) { showToast(problem, 'error'); return; }
    setBusy(true);
    const { error } = await supabase.from('worker_contracts').update({ status: 'signed', signed_name: name.trim(), signature_png: drawn }).eq('id', c.id);
    setBusy(false);
    if (error) { showToast(error.message, 'error'); return; }
    addAdminNotification({ type: 'contract_signed', title: `${currentWorker.name} signed their contract`, body: `${c.title} · signed as "${name.trim()}"`, worker_id: currentWorker.id }).catch(() => {});
    showToast('Signed. A copy stays here for you.', 'success'); onSigned?.();
  };

  return (
    <Modal title={c.title} onClose={onClose} width={720}>
      <div style={{ color: C.textDim, fontSize: 11.5, marginBottom: 10 }}>Version {c.template_version}{c.sent_at ? ` · sent ${fmtDateTime(c.sent_at)}` : ''}</div>
      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14, color: C.text, fontSize: 14, lineHeight: 1.65, whiteSpace: 'pre-wrap', maxHeight: '45vh', overflowY: 'auto' }}>{c.body}</div>
      {signed ? (
        <div style={{ marginTop: 14, color: C.success, fontSize: 13 }}>✓ You signed this as "{c.signed_name}" on {fmtDateTime(c.signed_at)}.</div>
      ) : (
        <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, color: C.text, fontSize: 13.5, cursor: 'pointer', minHeight: 44 }}>
            <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} style={{ marginTop: 3, width: 20, height: 20 }} />
            <span>I have read this contract and I agree to it.</span>
          </label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Type your full name" aria-label="Type your full name" style={inputStyle} autoComplete="name" />
          <div>
            <div style={{ color: C.textMuted, fontSize: 12, marginBottom: 4 }}>Draw your signature with your finger</div>
            <SignaturePad value={drawn} onChange={setDrawn} height={160} ariaLabel="Draw your signature" />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button onClick={onClose} disabled={busy} style={btnSecondary}>Not now</button>
            <button onClick={sign} disabled={busy} style={{ ...btnPrimary, minHeight: 44 }}>{busy ? 'Signing…' : 'Sign contract'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
