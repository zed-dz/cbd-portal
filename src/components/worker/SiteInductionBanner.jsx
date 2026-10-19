import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary } from '../../theme';
import { todayISO } from '../../utils/dates';
import { signatureProblem } from '../../utils/signatures';
import { SignaturePad } from '../ui/SignaturePad';

// Site induction / SWMS sign-on (2026-10-19). When a worker holds an accepted
// allocation at a site whose induction is REQUIRED and they have not signed
// the current version, a banner sits at the top of the worker portal. "Read &
// sign" opens a full-screen reader: the text, a tick, a typed full name, a
// finger-drawn signature (required since 2026-10-20), Sign.
// The signature row carries the version, so a re-published induction asks
// everyone again. Matching is by allocations.site_id (sites without an id on
// the allocation cannot be matched and are skipped).

export function SiteInductionBanner({ currentWorker, showToast }) {
  const [due, setDue] = useState([]);           // [{ induction, siteName }]
  const [reader, setReader] = useState(null);   // the induction being read

  const load = useCallback(async () => {
    const today = todayISO();
    const { data: allocs } = await supabase.from('allocations').select('site_id, site, client')
      .eq('worker_id', currentWorker.id).in('status', ['confirmed', 'completed'])
      .or(`end_date.is.null,end_date.gte.${today}`).not('site_id', 'is', null).limit(100);
    const siteIds = [...new Set((allocs || []).map(a => a.site_id).filter(Boolean))];
    if (!siteIds.length) { setDue([]); return; }
    const [{ data: inds }, { data: sigs }, { data: sites }] = await Promise.all([
      supabase.from('site_inductions').select('*').in('site_id', siteIds).eq('required', true).is('archived_at', null),
      supabase.from('site_induction_signatures').select('induction_id, version').eq('worker_id', currentWorker.id),
      supabase.from('client_sites').select('id, name').in('id', siteIds),
    ]);
    const signed = new Set((sigs || []).map(s => `${s.induction_id}:${s.version}`));
    const siteName = Object.fromEntries((sites || []).map(s => [s.id, s.name]));
    setDue((inds || []).filter(i => !signed.has(`${i.id}:${i.version}`)).map(i => ({ induction: i, siteName: siteName[i.site_id] || 'site' })));
  }, [currentWorker.id]);

  useEffect(() => { load(); }, [load]);

  if (!due.length && !reader) return null;
  const first = due[0];

  return (
    <>
      {first && (
        <div data-area="site induction banner" style={{ background: 'rgba(234,179,8,0.12)', borderBottom: '1px solid rgba(234,179,8,0.4)', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200, color: '#fde047', fontSize: 13.5, fontWeight: 600 }}>
            🦺 Site induction required for <strong>{first.siteName}</strong>{due.length > 1 ? ` (+${due.length - 1} more)` : ''}
          </div>
          <button onClick={() => setReader(first)} style={{ ...btnPrimary, minHeight: 36, padding: '8px 14px' }}>Read &amp; sign →</button>
        </div>
      )}
      {reader && (
        <InductionReader item={reader} currentWorker={currentWorker} showToast={showToast}
          onClose={() => setReader(null)} onSigned={() => { setReader(null); load(); }} />
      )}
    </>
  );
}

export function InductionReader({ item, currentWorker, showToast, onClose, onSigned }) {
  const [agree, setAgree] = useState(false);
  const [name, setName] = useState('');
  const [drawn, setDrawn] = useState('');
  const [busy, setBusy] = useState(false);
  const ind = item.induction;

  const sign = async () => {
    if (!agree) { showToast('Tick "I have read and understood" first.', 'error'); return; }
    const typed = name.trim();
    if (typed.length < 3) { showToast('Type your full name to sign.', 'error'); return; }
    const problem = signatureProblem(drawn);
    if (problem) { showToast(problem, 'error'); return; }
    setBusy(true);
    const { data, error } = await supabase.from('site_induction_signatures').insert([{
      induction_id: ind.id, worker_id: currentWorker.id, signed_name: typed, version: ind.version, signature_png: drawn,
    }]).select('id').single();
    setBusy(false);
    if (error) { showToast(error.message, 'error'); return; }
    supabase.functions.invoke('notify-admins-ops', { body: { kind: 'induction_signed', id: data.id } })
      .catch(e => console.error('notify-admins-ops failed:', e));
    showToast(`Signed — thanks ${typed.split(' ')[0]}.`, 'success');
    onSigned?.();
  };

  return (
    <div data-area="site induction reader" style={{ position: 'fixed', inset: 0, zIndex: 1200, background: C.bg, display: 'flex', flexDirection: 'column' }}>
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>Site induction · {item.siteName} · v{ind.version}</div>
          <div style={{ fontSize: 16, fontWeight: 800, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ind.title}</div>
        </div>
        <button onClick={onClose} style={{ ...btnSecondary, minHeight: 36, padding: '8px 12px' }}>Later</button>
      </div>
      {/* One scroll area: the text, then the signing block under it. A fixed
          footer with the pad in it would eat most of a 740 px phone screen. */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        <div style={{ maxWidth: 720, margin: '0 auto', background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, color: C.text, fontSize: 15, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
          {ind.content || 'No text yet — ask the office.'}
        </div>
        <div data-area="induction signing" style={{ maxWidth: 720, margin: '14px auto 0', background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, display: 'grid', gap: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: C.text, minHeight: 36 }}>
            <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} style={{ accentColor: C.accent, width: 20, height: 20 }} />
            I have read and understood this induction
          </label>
          <input style={{ ...inputStyle, width: '100%' }} value={name} onChange={e => setName(e.target.value)} placeholder="Type your full name" autoComplete="name" />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 6 }}>Sign with your finger *</div>
            <SignaturePad onChange={setDrawn} height={170} exportMaxWidth={600} ariaLabel="Induction signature — draw with your finger" />
          </div>
          {/* Full-width Sign button + bottom room: the floating help bubble sits
              bottom-right and covered a right-aligned button on 360 px phones. */}
          <div style={{ paddingBottom: 84 }}>
            <button onClick={sign} disabled={busy} style={{ ...btnPrimary, minHeight: 44, width: '100%' }}>{busy ? 'Signing…' : '✍ Sign'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
