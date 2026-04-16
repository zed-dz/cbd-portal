import { useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C } from '../../theme';
import { Spinner } from '../../components';

export function AppViewsPage({ showToast }) {
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data, error } = await supabase.from('workers').select('id, name, email, job_title, status, app_status, mobile').order('name');
      if (!mounted) return;
      if (error) showToast(error.message, 'error');
      else setWorkers(data || []);
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [showToast]);

  const statusColor = { available: C.success, on_site: C.accent, inactive: C.textMuted };

  return (
    <div>
      <div style={{ background: 'rgba(249,115,22,0.07)', border: '1px solid rgba(249,115,22,0.2)', borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: C.textMuted }}>
        📲 <strong style={{ color: C.text }}>App Views</strong> — shows each worker's portal view and current status. Click a worker to preview their allocation and timesheet data.
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
          {workers.map(w => (
            <div key={w.id} onClick={() => setSelected(selected?.id === w.id ? null : w)} style={{ background: C.card, borderRadius: 10, border: `1px solid ${selected?.id === w.id ? C.accent : C.border}`, padding: 18, cursor: 'pointer', transition: 'border-color 0.15s' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: C.cardHover, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>👷</div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{w.name}</div>
                  <div style={{ fontSize: 11, color: C.textMuted }}>{w.job_title || 'No role set'}</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(249,115,22,0.12)', color: C.accent, fontFamily: '"DM Mono", monospace' }}>{w.app_status || 'Active'}</span>
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: C.cardHover, color: statusColor[w.status] || C.textMuted, fontFamily: '"DM Mono", monospace' }}>{w.status || '—'}</span>
              </div>
              {selected?.id === w.id && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}`, fontSize: 12, color: C.textMuted }}>
                  <div>📧 {w.email || '—'}</div>
                  <div style={{ marginTop: 4 }}>📱 {w.mobile || '—'}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
