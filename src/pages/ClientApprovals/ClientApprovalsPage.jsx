import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { btnSmall } from '../../theme';
import { fmtDate } from '../../utils/dates';
import { Spinner, Badge, TableWrap, Th, Td, EmptyState, timesheetBadge } from '../../components';

export function ClientApprovalsPage({ showToast }) {
  const [timesheets, setTimesheets] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('timesheets').select('*, workers(name)').order('created_at', { ascending: false }).limit(50);
    if (error) showToast(error.message, 'error');
    else setTimesheets(data || []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const handleMarkClientApproved = async (ts) => {
    const { error } = await supabase.from('timesheets').update({ client_approved: true }).eq('id', ts.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Marked as client approved', 'success'); load(); }
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <Badge label="⚡ CLIENT APPROVAL TRACKING" color="blue" />
        <span style={{ color: '#8b90a8', fontSize: 13 }}>Mark timesheets as client-approved before final payroll processing.</span>
      </div>
      {timesheets.length === 0 ? <EmptyState message="No timesheets found." /> : (
        <TableWrap>
          <thead><tr><Th>Worker</Th><Th>Client</Th><Th>Site</Th><Th>Date</Th><Th>Hours</Th><Th>Status</Th><Th>Client Approved</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {timesheets.map(ts => (
              <tr key={ts.id}>
                <Td>{ts.workers?.name || '—'}</Td>
                <Td>{ts.client || '—'}</Td>
                <Td>{ts.site || '—'}</Td>
                <Td>{fmtDate(ts.date)}</Td>
                <Td>{ts.pay_hours ?? ts.hours ?? '—'}</Td>
                <Td>{timesheetBadge(ts.status)}</Td>
                <Td>
                  {ts.client_approved
                    ? <Badge label="✓ Approved" color="green" />
                    : <Badge label="Pending" color="yellow" />}
                </Td>
                <Td>
                  {!ts.client_approved && (
                    <button onClick={() => handleMarkClientApproved(ts)} style={{ ...btnSmall, color: '#4ade80' }}>Mark Approved</button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
