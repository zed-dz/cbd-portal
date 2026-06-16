import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary } from '../../theme';
import { Spinner, Field } from '../../components';

// cbd-portal doesn't ship the BRAND module that mra-portal uses; we inline
// the CBD-specific copy here to keep the file self-contained.
const BRAND = { shortName: 'CBD', tagline: 'Plant & Labour' };
const brandFooterLine = () => 'ROAD · RAIL · WATER  ·  ABN 75 663 693 070';

// Public application landing page at /apply (and /apply?type=client).
//
// Posts to the `submit-application` edge function which runs with
// service_role, bypasses RLS, validates server-side, and writes a row to
// worker_applications. The admin sees it in the Applications page.
//
// This is the destination we want the LinkedIn ad to point at — no Lovable
// dependency, lives on the same domain as the portal itself, identical
// branding. Marketing site's "Apply for a Job" CTAs can also be re-pointed
// here (or kept on the Lovable site if we deploy a matching form there).

export function ApplyPage({ initialType = 'worker' }) {
  const [type, setType]             = useState(initialType);
  const [fullName, setFullName]     = useState('');
  const [email, setEmail]           = useState('');
  const [phone, setPhone]           = useState('');
  const [message, setMessage]       = useState('');
  const [busy, setBusy]             = useState(false);
  const [error, setError]           = useState('');
  const [submitted, setSubmitted]   = useState(false);

  // Pre-fill the type from ?type= if provided (used by marketing-site CTAs
  // that distinguish workers vs clients).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = (params.get('type') || '').toLowerCase();
    if (t === 'worker' || t === 'client') setType(t);
  }, []);

  // Detect the source from the URL or referrer so we can attribute the lead
  // later (LinkedIn vs marketing site vs direct).
  const source = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const s = params.get('utm_source') || params.get('source');
    if (s) return s.toLowerCase();
    const ref = (document.referrer || '').toLowerCase();
    if (ref.includes('linkedin.com')) return 'linkedin-ad';
    if (ref.includes('miningresourcesaustralia.com')) return 'marketing-site';
    return 'portal-apply';
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!fullName.trim() || fullName.trim().length < 2) { setError('Please enter your full name.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) { setError("That email doesn't look right."); return; }
    setBusy(true);
    // We hit the edge function via supabase-js's functions.invoke — that uses
    // the project's anon key automatically and includes the right headers.
    const { error: fnErr } = await supabase.functions.invoke('submit-application', {
      body: { type, full_name: fullName.trim(), email: email.trim().toLowerCase(), phone: phone.trim() || null, message: message.trim() || null, source },
    });
    setBusy(false);
    if (fnErr) { setError(fnErr.message || 'Something went wrong. Please try again or email us directly.'); return; }
    setSubmitted(true);
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: `radial-gradient(ellipse 80% 60% at 50% -10%, rgba(249,115,22,0.12), transparent 60%), ${C.bg}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{ width: '100%', maxWidth: 460 }}>
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 38, fontWeight: 800, color: C.accent, lineHeight: 1, letterSpacing: -1 }}>{BRAND.shortName}</div>
          <div style={{ fontSize: 10, color: C.textMuted, fontFamily: MONO, letterSpacing: 2.8, textTransform: 'uppercase', marginTop: 6, fontWeight: 600 }}>{BRAND.tagline}</div>
        </div>

        <div style={{ background: C.card, borderRadius: R.xl, padding: 28, border: `1px solid ${C.border}`, boxShadow: '0 24px 60px -20px rgba(0,0,0,0.6)' }}>
          {submitted ? (
            <div>
              <div style={{ fontSize: 38, marginBottom: 10 }}>✓</div>
              <h2 style={{ fontSize: 22, fontWeight: 700, color: C.text, marginBottom: 8, letterSpacing: -0.3 }}>Thanks — you're in.</h2>
              <p style={{ color: C.textMuted, fontSize: 14, lineHeight: 1.55, marginBottom: 14 }}>
                We've received your application and someone will be in touch within 1–2 business days. Keep an eye on your email and SMS.
              </p>
              <p style={{ color: C.textDim, fontSize: 12, lineHeight: 1.55 }}>
                If you've got a question right now, email <a href={`mailto:info@cbdpnl.com.au`} style={{ color: C.accent }}>info@cbdpnl.com.au</a>.
              </p>
            </div>
          ) : (
            <>
              {/* Tabs */}
              <div style={{ display: 'flex', gap: 4, marginBottom: 22, background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.md, padding: 3 }}>
                {[
                  { id: 'worker', label: 'Apply for a Job' },
                  { id: 'client', label: 'Apply for Credit' },
                ].map(t => {
                  const active = type === t.id;
                  return (
                    <button key={t.id} type="button" onClick={() => setType(t.id)}
                      style={{ flex: 1, padding: '7px 8px', border: 'none', cursor: 'pointer', background: active ? C.cardHover : 'transparent', color: active ? C.text : C.textMuted, borderRadius: R.sm, fontWeight: active ? 600 : 500, fontSize: 13, transition: 'all 120ms' }}>
                      {t.label}
                    </button>
                  );
                })}
              </div>

              <h2 style={{ fontSize: 19, fontWeight: 700, color: C.text, marginBottom: 4, letterSpacing: -0.3 }}>
                {type === 'worker' ? 'Get on a job' : 'Open a credit account'}
              </h2>
              <p style={{ color: C.textMuted, fontSize: 13, marginBottom: 20, lineHeight: 1.5 }}>
                {type === 'worker'
                  ? 'Quick application — we just need a way to reach you. We follow up within 1–2 business days.'
                  : 'Tell us about your project. We come back with rates and a credit terms proposal within 1–2 business days.'}
              </p>

              <form onSubmit={handleSubmit}>
                <Field label="Full name">
                  <input style={inputStyle} value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Jane Smith" autoComplete="name" autoFocus required />
                </Field>
                <Field label="Email">
                  <input style={inputStyle} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required />
                </Field>
                <Field label="Mobile" hint="Optional — but recommended, we can SMS you faster than email.">
                  <input style={inputStyle} type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="0412 345 678" autoComplete="tel" />
                </Field>
                <Field label={type === 'worker' ? 'What machinery / tickets do you operate?' : 'Tell us about the project'} hint="Optional. A few lines is plenty.">
                  <textarea
                    value={message}
                    onChange={e => setMessage(e.target.value)}
                    placeholder={type === 'worker' ? 'e.g. 8t excavator, dozer, ticketed for confined space' : 'e.g. mine site near Mudgee, expect 6 months work, need plant + operators'}
                    rows={4}
                    style={{ ...inputStyle, resize: 'vertical', minHeight: 80, fontFamily: 'inherit' }}
                  />
                </Field>
                {error && (
                  <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.28)', borderRadius: R.md, padding: '9px 12px', color: '#fca5a5', fontSize: 12.5, marginBottom: 14 }}>{error}</div>
                )}
                <button type="submit" disabled={busy} style={{ ...btnPrimary, width: '100%', padding: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 14, fontWeight: 700, marginTop: 4 }}>
                  {busy ? <><Spinner size={14} /> Sending…</> : 'Submit application →'}
                </button>
              </form>
            </>
          )}
        </div>

        <div style={{ marginTop: 20, textAlign: 'center', color: C.textDim, fontSize: 10.5, fontFamily: MONO, letterSpacing: 1.2 }}>
          {brandFooterLine()}
        </div>
      </div>
    </div>
  );
}
