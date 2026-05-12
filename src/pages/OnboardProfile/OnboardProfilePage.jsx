import { useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary } from '../../theme';
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
        <div style={{ fontSize: 38, marginBottom: 10 }}>⚠️</div>
        <div style={{ color: C.text, fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Link unavailable</div>
        <div style={{ color: C.textMuted, fontSize: 13 }}>{error || 'No profile found for this invite link.'}</div>
      </Centered>
    );
  }

  if (saved) {
    return (
      <Centered>
        <div style={{ fontSize: 44, marginBottom: 12 }}>🎉</div>
        <div style={{ color: C.text, fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Thanks, {profile.name.split(' ')[0]}!</div>
        <div style={{ color: C.textMuted, fontSize: 14, maxWidth: 360, textAlign: 'center' }}>
          Your profile has been updated. The CBD team will review and reach out about next steps and a worker login.
        </div>
      </Centered>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, padding: '24px 16px' }}>
      <div style={{ maxWidth: 540, margin: '0 auto' }}>
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 26, fontWeight: 800, color: C.accent, lineHeight: 1 }}>CBD</div>
          <div style={{ fontSize: 9, color: C.textMuted, fontFamily: '"DM Mono", monospace', letterSpacing: 2, textTransform: 'uppercase', marginTop: 2 }}>Plant & Labour · Onboarding</div>
        </div>

        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '22px 22px' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.text, marginBottom: 4 }}>Welcome, {profile.name.split(' ')[0]}.</div>
          <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 18 }}>
            Fill out a few details so we can put you on a job. Takes about a minute.
          </div>

          <form onSubmit={handleSubmit}>
            <Field label="Mobile">
              <input style={inputStyle} type="tel" value={form.mobile}
                onChange={e => setForm(f => ({ ...f, mobile: e.target.value }))}
                placeholder="04xx xxx xxx" />
            </Field>
            <Field label="Address">
              <input style={inputStyle} value={form.address}
                onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                placeholder="Street, Suburb, State, Postcode" />
            </Field>
            <Field label="Licences / Tickets">
              <textarea style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
                value={form.licences}
                onChange={e => setForm(f => ({ ...f, licences: e.target.value }))}
                placeholder="e.g. White Card, EWP, VOC Excavator, RIW…" />
            </Field>

            <button type="submit" disabled={saving} style={{ ...btnPrimary, width: '100%', marginTop: 10 }}>
              {saving ? 'Saving…' : 'Submit my details'}
            </button>
          </form>
        </div>

        <div style={{ marginTop: 18, fontSize: 11, color: C.textMuted, textAlign: 'center', fontFamily: '"DM Mono", monospace' }}>
          CBD Plant & Labour · ABN 75 663 693 070
        </div>
      </div>
    </div>
  );
}

function Centered({ children }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: C.bg, padding: 24 }}>
      {children}
    </div>
  );
}
