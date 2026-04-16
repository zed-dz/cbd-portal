import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { btnSmall } from '../../theme';
import { Spinner, Badge, EmptyState } from '../../components';

export function PendingWorkersPage({ showToast }) {
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('workers').select('*').neq('app_status', 'Active').order('created_at', { ascending: false });
    if (error) showToast(error.message, 'error');
    else setWorkers(data || []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const handleRemind = (w) => showToast(`Reminder sent to ${w.name.split(' ')[0]}`, 'success');

  const appStatusColor = (s) => s === 'Invite Sent' ? 'blue' : s === 'Completing Profile' ? 'yellow' : s === 'Profile Incomplete' ? 'yellow' : 'gray';

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;
  if (!workers.length) return <EmptyState message="All workers are active — no pending onboarding." />;

  return (
    <div>
      <div style={{ color: '#8b90a8', fontSize: 14, marginBottom: 20 }}>Workers who haven't completed their profile or accepted their invite.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
        {workers.map(w => (
          <div key={w.id} style={{ background: '#131620', borderRadius: 10, border: '1px solid #2a2f40', padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div>
                <div style={{ fontWeight: 700, color: '#e8eaf2', fontSize: 15 }}>{w.name}</div>
                <div style={{ color: '#8b90a8', fontSize: 12, marginTop: 2 }}>{w.email}</div>
                {w.job_title && <div style={{ color: '#8b90a8', fontSize: 12 }}>{w.job_title}</div>}
              </div>
              <Badge label={w.app_status || 'Pending'} color={appStatusColor(w.app_status)} />
            </div>
            {w.mobile && <div style={{ color: '#8b90a8', fontSize: 13, marginBottom: 10 }}>📱 {w.mobile}</div>}
            <button onClick={() => handleRemind(w)} style={{ ...btnSmall, width: '100%' }}>📧 Send Reminder</button>
          </div>
        ))}
      </div>
    </div>
  );
}
