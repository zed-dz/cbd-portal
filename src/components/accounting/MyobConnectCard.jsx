import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, btnPrimary, btnSmall } from '../../theme';

// MYOB connection card (Payroll Config). Drives the myob-start / myob-callback
// / myob-status / myob-select-file edge functions. Three states:
//   not configured  -> the developer-app keys are not in the Supabase secrets yet
//   configured      -> show the Connect button (full-page redirect, OAuth needs it)
//   connected       -> green chip + pick WHICH company file pushes will target
// No token ever reaches the browser — myob-status only reports booleans/names.
export function MyobConnectCard({ showToast }) {
  const [st, setSt] = useState(null);
  const [picking, setPicking] = useState('');

  const load = useCallback(async () => {
    const { data, error } = await supabase.functions.invoke('myob-status', { body: {} });
    if (error) { setSt({ error: error.message }); return; }
    setSt(data);
  }, []);

  useEffect(() => {
    load();
    // Coming back from MYOB consent lands on ?myob=connected — refresh once.
    if (new URLSearchParams(window.location.search).get('myob') === 'connected') {
      showToast?.('MYOB connected ✓ — now pick the company file below', 'success');
    }
  }, [load, showToast]);

  const connect = () => {
    // Same-tab redirect: the OAuth consent flow must own the page.
    window.location.href = `${process.env.REACT_APP_SUPABASE_URL}/functions/v1/myob-start`;
  };

  const pickFile = async (f) => {
    setPicking(f.id);
    const { data, error } = await supabase.functions.invoke('myob-select-file', {
      body: { id: f.id, name: f.name },
    });
    if (error || data?.error) showToast?.(`Could not select file: ${error?.message || data?.error}`, 'error');
    else { showToast?.(`MYOB pushes will target “${f.name}”`, 'success'); await load(); }
    setPicking('');
  };

  const box = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px', marginBottom: 20 };
  const title = <strong style={{ color: C.text }}>MYOB connection</strong>;

  if (!st) return <div style={box}>🔌 {title} — checking…</div>;
  if (st.error) return <div style={box}>🔌 {title} — status check failed: {st.error}</div>;

  if (!st.configured) {
    return (
      <div style={{ ...box, borderColor: 'rgba(234,179,8,0.35)' }}>
        🔌 {title}
        <div style={{ fontSize: 13, color: C.textMuted, marginTop: 6 }}>
          Not configured yet — waiting on the MYOB developer-app keys
          (<code style={{ fontSize: 11 }}>MYOB_CLIENT_ID</code> / <code style={{ fontSize: 11 }}>MYOB_CLIENT_SECRET</code> in the Supabase secrets).
          Once they are set, a Connect button appears here.
        </div>
      </div>
    );
  }

  if (!st.connected) {
    return (
      <div style={box}>
        🔌 {title}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
          <button onClick={connect} style={{ ...btnPrimary, padding: '8px 16px' }}>Connect MYOB</button>
          <span style={{ fontSize: 12.5, color: C.textMuted }}>
            Opens MYOB’s own consent page — sign in with the MYOB account that was invited to the company file.
          </span>
        </div>
      </div>
    );
  }

  const files = st.company_files || [];
  return (
    <div style={{ ...box, borderColor: 'rgba(34,197,94,0.35)' }}>
      🔌 {title}{' '}
      <span style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e', borderRadius: 5, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
        Connected{st.connected_at ? ` · ${new Date(st.connected_at).toLocaleDateString('en-AU')}` : ''}
      </span>
      <div style={{ fontSize: 13, color: C.textMuted, marginTop: 8 }}>
        {st.selected_file
          ? <>Pushes target <strong style={{ color: C.text }}>{st.selected_file}</strong>. Change it below if needed.</>
          : <>Pick the company file pushes should target — <strong style={{ color: C.text }}>use the test file first</strong>.</>}
      </div>
      {files.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {files.map(f => (
            <button key={f.id} onClick={() => pickFile(f)} disabled={!!picking}
              style={{ ...btnSmall, ...(st.selected_file === f.name ? { borderColor: '#22c55e', color: '#22c55e' } : {}) }}>
              {picking === f.id ? 'Saving…' : f.name}
            </button>
          ))}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <button onClick={connect} style={{ ...btnSmall }}>Reconnect</button>
      </div>
    </div>
  );
}
