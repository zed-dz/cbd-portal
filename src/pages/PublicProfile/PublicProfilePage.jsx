import { useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO } from '../../theme';
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
  const initials = (profile.name || '?').split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

  return (
    <div style={{
      minHeight: '100vh',
      background: `radial-gradient(ellipse 70% 50% at 50% 0%, rgba(249,115,22,0.10), transparent 65%), ${C.bg}`,
      padding: '28px 16px 48px',
    }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        {/* Brand header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
          <div>
            <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 30, fontWeight: 800, color: C.accent, lineHeight: 1, letterSpacing: -0.5 }}>CBD</div>
            <div style={{ fontSize: 10, color: C.textMuted, fontFamily: MONO, letterSpacing: 2.5, textTransform: 'uppercase', marginTop: 4 }}>Plant & Labour</div>
          </div>
          {profile.qualified && (
            <span style={{
              background: 'rgba(34,197,94,0.13)', color: '#86efac',
              fontSize: 10.5, fontWeight: 700,
              padding: '6px 12px', borderRadius: R.pill,
              letterSpacing: 1.2, textTransform: 'uppercase',
              border: '1px solid rgba(34,197,94,0.28)',
            }}>✓ Qualified Worker</span>
          )}
        </div>

        {/* Hero card */}
        <div style={{
          background: C.card, border: `1px solid ${C.border}`, borderRadius: R.xl,
          padding: '28px 26px', marginBottom: 14,
          boxShadow: '0 20px 48px -20px rgba(0,0,0,0.5)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            {/* Avatar (initials) */}
            <div style={{
              width: 64, height: 64, borderRadius: '50%',
              background: `linear-gradient(135deg, ${C.accent} 0%, #ea580c 100%)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 22, fontWeight: 800, color: '#fff',
              fontFamily: 'Syne, sans-serif', letterSpacing: -0.5,
              flexShrink: 0,
            }}>{initials || '👷'}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 28, fontWeight: 800, color: C.text, lineHeight: 1.05, letterSpacing: -0.5 }}>
                {profile.name}
              </div>
              {profile.job_title && (
                <div style={{ color: C.accent, fontSize: 14, fontWeight: 600, marginTop: 6 }}>{profile.job_title}</div>
              )}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
                {profile.worker_type && <Badge label={profile.worker_type.replace('-', ' ')} color="blue" />}
                <Badge label={profile.status || 'available'} color={profile.status === 'on_site' ? 'green' : 'blue'} />
              </div>
            </div>
          </div>
        </div>

        {/* Licences */}
        <Section title="Licences & Tickets" count={licences.length}>
          {licences.length === 0 ? (
            <div style={{ color: C.textMuted, fontSize: 13 }}>None listed.</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {licences.map((l, i) => (
                <span key={i} style={{
                  background: 'rgba(249,115,22,0.10)',
                  color: '#fdba74',
                  border: '1px solid rgba(249,115,22,0.22)',
                  fontSize: 12, fontWeight: 600,
                  padding: '5px 11px', borderRadius: R.sm,
                }}>{l}</span>
              ))}
            </div>
          )}
        </Section>

        {/* Certifications */}
        <Section title="Certifications" count={certs.length}>
          {certs.length === 0 ? (
            <div style={{ color: C.textMuted, fontSize: 13 }}>None on file.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {certs.map((c, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  background: C.bg, border: `1px solid ${C.border}`,
                  borderRadius: R.md, padding: '11px 14px',
                  gap: 12,
                }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text }}>{c.cert_name}</div>
                    {c.issuer && <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 1 }}>{c.issuer}</div>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                    <span style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO }}>
                      {c.expiry ? fmtDate(c.expiry) : 'No expiry'}
                    </span>
                    {certBadge(c.expiry)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Current placement */}
        {(profile.site || profile.client) && (
          <Section title="Current Placement">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {profile.client && <Row label="Client" value={profile.client} />}
              {profile.site   && <Row label="Site"   value={profile.site} />}
            </div>
          </Section>
        )}

        {/* Footer */}
        <div style={{
          marginTop: 28, paddingTop: 18, borderTop: `1px solid ${C.border}`,
          fontSize: 10.5, color: C.textDim, textAlign: 'center',
          fontFamily: MONO, letterSpacing: 1.2,
        }}>
          CBD Plant & Labour · ABN 75 663 693 070 · ROAD · RAIL · WATER<br />
          <span style={{ opacity: 0.7 }}>Profile generated {new Date(profile.generated_at).toLocaleDateString('en-AU')}</span>
        </div>
      </div>
    </div>
  );
}

function Section({ title, count, children }) {
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      borderRadius: R.lg, padding: '18px 20px', marginBottom: 12,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 14,
      }}>
        <div style={{
          fontSize: 10.5, fontWeight: 700, color: C.textMuted,
          letterSpacing: 1.5, textTransform: 'uppercase', fontFamily: MONO,
        }}>{title}</div>
        {count != null && count > 0 && (
          <span style={{
            background: C.bg, color: C.textMuted,
            fontSize: 10, fontWeight: 700, fontFamily: MONO,
            padding: '2px 8px', borderRadius: R.pill,
            border: `1px solid ${C.border}`,
          }}>{count}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 13.5 }}>
      <span style={{ color: C.textMuted, minWidth: 70 }}>{label}</span>
      <strong style={{ color: C.text, fontWeight: 600 }}>{value}</strong>
    </div>
  );
}
