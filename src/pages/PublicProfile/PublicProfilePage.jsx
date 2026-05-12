import { useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C } from '../../theme';
import { fmtDate } from '../../utils/dates';
import { Spinner, Badge, certBadge } from '../../components';

export function PublicProfilePage({ token }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data, error } = await supabase.rpc('get_public_worker_profile', { token });
      if (!mounted) return;
      if (error) setError(error.message);
      else if (!data || data.length === 0) setError('Profile not found or link has expired.');
      else setProfile(data[0]);
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [token]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg }}>
        <Spinner size={36} />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg, padding: 24 }}>
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <div style={{ fontSize: 38, marginBottom: 10 }}>🔒</div>
          <div style={{ color: C.text, fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Profile unavailable</div>
          <div style={{ color: C.textMuted, fontSize: 13 }}>{error || 'No profile found for this link.'}</div>
        </div>
      </div>
    );
  }

  const licences = (profile.licences || '').split(',').map(s => s.trim()).filter(Boolean);
  const certs    = profile.certifications || [];

  return (
    <div style={{ minHeight: '100vh', background: C.bg, padding: '24px 16px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        {/* Brand header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 28, fontWeight: 800, color: C.accent, lineHeight: 1 }}>CBD</div>
            <div style={{ fontSize: 9, color: C.textMuted, fontFamily: '"DM Mono", monospace', letterSpacing: 2, textTransform: 'uppercase', marginTop: 2 }}>Plant & Labour</div>
          </div>
          {profile.qualified && (
            <span style={{
              background: 'rgba(34,197,94,0.15)', color: C.success, fontSize: 11, fontWeight: 700,
              padding: '5px 11px', borderRadius: 12, letterSpacing: 1, textTransform: 'uppercase',
            }}>✅ Qualified Worker</span>
          )}
        </div>

        {/* Headline card */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: '28px 24px', marginBottom: 16 }}>
          <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 30, fontWeight: 800, color: C.text, lineHeight: 1.1 }}>
            {profile.name}
          </div>
          {profile.job_title && (
            <div style={{ color: C.accent, fontSize: 15, fontWeight: 600, marginTop: 6 }}>{profile.job_title}</div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            {profile.worker_type && <Badge label={profile.worker_type.replace('-', ' ')} color="blue" />}
            <Badge label={profile.status || 'available'} color={profile.status === 'on_site' ? 'green' : 'blue'} />
          </div>
        </div>

        {/* Licences */}
        <Section title="Licences & Tickets">
          {licences.length === 0 ? (
            <div style={{ color: C.textMuted, fontSize: 13 }}>None listed.</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {licences.map((l, i) => (
                <span key={i} style={{
                  background: 'rgba(249,115,22,0.12)', color: C.accent, fontSize: 12, fontWeight: 600,
                  padding: '4px 10px', borderRadius: 6,
                }}>{l}</span>
              ))}
            </div>
          )}
        </Section>

        {/* Certifications */}
        <Section title="Certifications">
          {certs.length === 0 ? (
            <div style={{ color: C.textMuted, fontSize: 13 }}>None on file.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {certs.map((c, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px',
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{c.cert_name}</div>
                    {c.issuer && <div style={{ fontSize: 11, color: C.textMuted }}>{c.issuer}</div>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: C.textMuted, fontFamily: '"DM Mono", monospace' }}>
                      {c.expiry ? fmtDate(c.expiry) : 'No expiry'}
                    </span>
                    {certBadge(c.expiry)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Current placement (optional) */}
        {(profile.site || profile.client) && (
          <Section title="Current Placement">
            {profile.client && <div style={{ color: C.text, fontSize: 14, marginBottom: 4 }}>Client: <strong>{profile.client}</strong></div>}
            {profile.site   && <div style={{ color: C.text, fontSize: 14 }}>Site: <strong>{profile.site}</strong></div>}
          </Section>
        )}

        {/* Footer */}
        <div style={{ marginTop: 24, fontSize: 11, color: C.textMuted, textAlign: 'center', fontFamily: '"DM Mono", monospace' }}>
          CBD Plant & Labour · ABN 75 663 693 070 · Generated {new Date(profile.generated_at).toLocaleDateString('en-AU')}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 12 }}>
        {title}
      </div>
      {children}
    </div>
  );
}
