import { useState, useEffect, useRef } from 'react';
import { C } from '../../theme';

// Omni Knowledge help bubble. Talks to Venture Command's ecosystem API:
//  - /api/ecosystem/config  → is Omni Knowledge toggled on for this venture?
//  - /api/ecosystem/ask     → read-only Q&A answered by VC's LLM with the
//    portal knowledge base. The app key is a low-privilege, read-only key
//    (Q&A + config only, never actions) so it is safe in the client; rotate it
//    in VC (/assets) any time. Override via REACT_APP_* if you prefer env vars.
const VC_URL = process.env.REACT_APP_VC_URL || 'https://venture-command.vercel.app';
const ECO_KEY = process.env.REACT_APP_ECOSYSTEM_KEY || 'eco_ad33269dae0847c08ecb6f01b0d7ff9d';

export function OmniHelpBubble() {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [msgs, setMsgs] = useState([]);
  const [loading, setLoading] = useState(false);
  const endRef = useRef(null);

  useEffect(() => {
    fetch(`${VC_URL}/api/ecosystem/config?key=${encodeURIComponent(ECO_KEY)}`)
      .then((r) => r.json())
      .then((d) => {
        if ((d.assets || []).some((a) => a.key === 'omni_knowledge')) setEnabled(true);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs, loading]);

  if (!enabled) return null;

  const ask = async () => {
    const question = q.trim();
    if (!question || loading) return;
    setMsgs((m) => [...m, { role: 'user', text: question }]);
    setQ('');
    setLoading(true);
    try {
      const r = await fetch(`${VC_URL}/api/ecosystem/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ECO_KEY}` },
        body: JSON.stringify({ question }),
      });
      const d = await r.json();
      setMsgs((m) => [...m, { role: 'omni', text: d.answer || d.error || 'Sorry, I could not answer that.' }]);
    } catch {
      setMsgs((m) => [...m, { role: 'omni', text: 'Connection error — please try again.' }]);
    }
    setLoading(false);
  };

  return (
    <>
      {open && (
        <div style={{ position: 'fixed', bottom: 88, right: 20, width: 340, maxWidth: 'calc(100vw - 40px)', height: 460, maxHeight: 'calc(100vh - 140px)', background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, boxShadow: '0 16px 48px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', zIndex: 9999, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 700, color: C.text, fontSize: 14 }}>💬 Portal Help</div>
            <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {msgs.length === 0 && (
              <div style={{ color: C.textMuted, fontSize: 13 }}>
                Ask me anything about using the portal — timesheets, your next job, updating your details…
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%', padding: '8px 12px', borderRadius: 10, fontSize: 13, lineHeight: 1.45, whiteSpace: 'pre-wrap', background: m.role === 'user' ? C.accent : C.bg, color: m.role === 'user' ? '#fff' : C.text, border: m.role === 'user' ? 'none' : `1px solid ${C.border}` }}>
                {m.text}
              </div>
            ))}
            {loading && <div style={{ alignSelf: 'flex-start', color: C.textMuted, fontSize: 13 }}>Omni is thinking…</div>}
            <div ref={endRef} />
          </div>
          <div style={{ padding: 10, borderTop: `1px solid ${C.border}`, display: 'flex', gap: 8 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} placeholder="Type your question…" style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px', color: C.text, fontSize: 13, outline: 'none' }} />
            <button onClick={ask} disabled={loading} style={{ background: C.accent, color: '#fff', border: 'none', borderRadius: 8, padding: '0 14px', cursor: 'pointer', fontWeight: 700, fontSize: 16 }}>→</button>
          </div>
        </div>
      )}
      <button onClick={() => setOpen((o) => !o)} title="Portal help" style={{ position: 'fixed', bottom: 20, right: 20, width: 56, height: 56, borderRadius: '50%', background: C.accent, color: '#fff', border: 'none', cursor: 'pointer', fontSize: 24, boxShadow: '0 8px 24px rgba(0,0,0,0.35)', zIndex: 9999 }}>
        {open ? '×' : '💬'}
      </button>
    </>
  );
}
