import { useEffect, useState } from 'react';
import { C } from '../../theme';

// Public, link-only video page (2026-11-12): /videos/<token>. No login. The token is the name of an
// unguessable folder in the public `client-videos` storage bucket; anon users cannot list the bucket, so
// only people with the link can find the files. The page is noindex and linked from nowhere.
const BASE = `${process.env.REACT_APP_SUPABASE_URL}/storage/v1/object/public/client-videos`;

const GROUPS = [
  { key: 'crew', title: 'For your crew', sub: 'Short phone videos. Send them by text or WhatsApp.' },
  { key: 'supervisor', title: 'For site supervisors', sub: 'How to sign off the crew hours from the link.' },
  { key: 'office', title: 'For the office', sub: 'Allocations, approvals, payroll and Xero.' },
  { key: 'portal', title: 'About the portal', sub: 'What the CBD portal does, in about a minute.' },
];

const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function ClientVideosPage({ token }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const meta = document.createElement('meta'); meta.name = 'robots'; meta.content = 'noindex, nofollow';
    document.head.appendChild(meta); const oldTitle = document.title; document.title = 'CBD Plant & Labour — Video guides';
    return () => { meta.remove(); document.title = oldTitle; };
  }, []);

  useEffect(() => {
    let live = true;
    fetch(`${BASE}/${token}/manifest.json`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (live) setItems(Array.isArray(d) ? d : []); })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [token]);

  const wrap = { minHeight: '100vh', background: C.bg, color: C.text, padding: '28px 16px 60px', boxSizing: 'border-box' };
  const inner = { maxWidth: 1100, margin: '0 auto' };

  if (error) return (
    <div style={wrap}><div style={inner}>
      <h1 style={{ fontSize: 22 }}>This link is not valid</h1>
      <p style={{ color: C.textMuted }}>Ask the CBD office for a new link.</p>
    </div></div>
  );
  if (!items) return <div style={wrap}><div style={{ ...inner, color: C.textMuted }}>Loading videos…</div></div>;

  return (
    <div style={wrap}>
      <div style={inner}>
        <div style={{ height: 4, width: 56, background: C.accent, borderRadius: 4, marginBottom: 18 }} />
        <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: 0.3 }}>CBD <span style={{ color: C.accent }}>Plant &amp; Labour</span></div>
        <h1 style={{ fontSize: 'clamp(26px, 6vw, 40px)', lineHeight: 1.1, margin: '10px 0 6px' }}>Video guides</h1>
        <p style={{ color: C.textMuted, margin: '0 0 8px', fontSize: 15, maxWidth: 620 }}>
          Short videos on how to use the CBD portal. Captions are built in. Tap a video to play it.
        </p>
        {GROUPS.map(g => {
          const list = items.filter(i => i.group === g.key);
          if (!list.length) return null;
          const wide = g.key === 'portal';
          return (
            <section key={g.key} style={{ marginTop: 34 }}>
              <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>{g.title}</h2>
              <p style={{ color: C.textMuted, margin: '0 0 14px', fontSize: 14 }}>{g.sub}</p>
              <div style={{ display: 'grid', gap: 16, gridTemplateColumns: wide ? 'repeat(auto-fit, minmax(min(100%, 460px), 1fr))' : 'repeat(auto-fill, minmax(min(100%, 230px), 280px))' }}>
                {list.map(v => (
                  <figure key={v.slug} style={{ margin: 0, background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 10 }}>
                    <video controls playsInline preload="none" crossOrigin="anonymous" poster={`${BASE}/${token}/${v.slug}.jpg`}
                      style={{ width: '100%', aspectRatio: wide ? '16 / 9' : '9 / 16', background: '#000', borderRadius: 10, display: 'block' }}>
                      <source src={`${BASE}/${token}/${v.slug}.mp4`} type="video/mp4" />
                      <track kind="captions" srcLang="en" label="English" src={`${BASE}/${token}/${v.slug}.vtt`} />
                    </video>
                    <figcaption style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '10px 4px 2px', fontSize: 14 }}>
                      <span style={{ fontWeight: 700 }}>{v.title}</span>
                      <span style={{ color: C.textMuted, whiteSpace: 'nowrap' }}>{mmss(v.secs)}</span>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          );
        })}
        <p style={{ color: C.textDim, fontSize: 12, marginTop: 40 }}>Questions? Call the CBD office.</p>
      </div>
    </div>
  );
}
