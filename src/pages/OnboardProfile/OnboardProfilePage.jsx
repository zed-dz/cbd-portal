import { useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary } from '../../theme';
import { Spinner, Field } from '../../components';

export function OnboardProfilePage({ token }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const [form, setForm] = useState({ mobile: '', address: '', licences: '' });

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data, error } = await supabase.rpc('get_public_worker_profile', { token });
      if (!mounted) return;
      if (error) setError(error.message);
      else if (!data || data.length === 0) setError('Invite link is invalid or has expired.');
      else {
        const p = data[0];
        setProfile(p);
        setForm({ mobile: p.mobile || '', address: '', licences: p.licences || '' });
      }
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    const { error } = await supabase.rpc('update_worker_via_token', {
      token,
      p_mobile:   form.mobile   || null,
      p_address:  form.address  || null,
      p_licences: form.licences || null,
    });
    if (error) setError(error.message);
    else setSaved(true);
    setSaving(false);
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg }}>
        <Spinner size={36} />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <Centered>
        <div style={{ fontSize: 42, marginBottom: 12 }}>⚠️</div>
        <div style={{ color: C.text, fontSize: 19, fontWeight: 700, marginBottom: 6 }}>Link unavailable</div>
        <div style={{ color: C.textMuted, fontSize: 13, maxWidth: 360 }}>{error || 'No profile found for this invite link.'}</div>
      </Centered>
    );
  }

  if (saved) {
    return (
      <Centered>
        <div style={{ fontSize: 52, marginBottom: 14 }}>🎉</div>
        <div style={{ color: C.text, fontSize: 22, fontWeight: 700, marginBottom: 8, fontFamily: 'Syne, sans-serif' }}>Thanks, {profile.name.split(' ')[0]}!</div>
        <div style={{ color: C.textMuted, fontSize: 14, maxWidth: 380, textAlign: 'center', lineHeight: 1.55 }}>
          Your profile has been updated. The CBD team will review it shortly and reach out about next steps and a worker login.
        </div>
      </Centered>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: `radial-gradient(ellipse 70% 50% at 50% 0%, rgba(249,115,22,0.10), transparent 65%), ${C.bg}`,
      padding: '28px 16px 48px',
    }}>
      <div style={{ maxWidth: 520, margin: '0 auto' }}>
        {/* Brand */}
        <div style={{ marginBottom: 22 }}>
          <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 28, fontWeight: 800, color: C.accent, lineHeight: 1, letterSpacing: -0.5 }}>CBD</div>
          <div style={{ fontSize: 10, color: C.textMuted, fontFamily: MONO, letterSpacing: 2.5, textTransform: 'uppercase', marginTop: 4 }}>Plant & Labour · Onboarding</div>
        </div>

        <div style={{
          background: C.card, border: `1px solid ${C.border}`, borderRadius: R.xl,
          padding: '26px 26px 22px',
          boxShadow: '0 20px 48px -20px rgba(0,0,0,0.5)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <div style={{ width: 36, height: 36, borderRadius: R.pill, background: 'rgba(249,115,22,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>👋</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: C.text, fontFamily: 'Syne, sans-serif', letterSpacing: -0.3 }}>
              Welcome, {profile.name.split(' ')[0]}.
            </div>
          </div>
          <div style={{ fontSize: 13.5, color: C.textMuted, marginBottom: 20, lineHeight: 1.5 }}>
            Fill out a few details so we can put you on a job. Takes about a minute.
          </div>

          <form onSubmit={handleSubmit}>
            <Field label="Mobile" hint="We'll use this to text you about shifts.">
              <input style={inputStyle} type="tel" value={form.mobile}
                onChange={e => setForm(f => ({ ...f, mobile: e.target.value }))}
                placeholder="04xx xxx xxx" />
            </Field>
            <Field label="Address">
              <input style={inputStyle} value={form.address}
                onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                placeholder="Street, Suburb, State, Postcode" />
            </Field>
            <Field label="Licences / Tickets" hint="Separate with commas. We'll record expiry dates later.">
              <textarea style={{ ...inputStyle, minHeight: 88, resize: 'vertical' }}
                value={form.licences}
                onChange={e => setForm(f => ({ ...f, licences: e.target.value }))}
                placeholder="e.g. White Card, EWP, VOC Excavator, RIW…" />
            </Field>

            <button type="submit" disabled={saving} style={{
              ...btnPrimary, width: '100%', padding: '12px', marginTop: 6,
              fontSize: 14, fontWeight: 700,
            }}>
              {saving ? 'Saving…' : 'Submit my details →'}
            </button>
          </form>
        </div>

        <div style={{
          marginTop: 18, textAlign: 'center',
          fontSize: 10.5, color: C.textDim, fontFamily: MONO, letterSpacing: 1.2,
        }}>
          CBD Plant & Labour · ABN 75 663 693 070
        </div>
      </div>
    </div>
  );
}

function Centered({ children }) {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: `radial-gradient(ellipse 70% 50% at 50% 0%, rgba(249,115,22,0.10), transparent 65%), ${C.bg}`,
      padding: 24, textAlign: 'center',
    }}>
      {children}
    </div>
  );
}
