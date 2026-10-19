import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnDanger } from '../../theme';
import { fmtDate, fmtDateTime } from '../../utils/dates';
import { logActivity } from '../../utils/activity';
import { Spinner, EmptyState, Modal, Field } from '../../components';
import { leaveBadge } from '../../components/worker/TimeOffTab';

// Time off requests — office side (2026-10-19). Pending first. Approve writes
// the same worker_unavailability row the Allocation Board already reads, so
// the days grey out there; the worker sees the decision in their Time off tab
// and gets a text / email through notify-worker (office-gated).

export function LeaveRequestsPage({ showToast, currentWorker, refreshBadge }) {
  const [rows, setRows] = useState([]);
  const [workers, setWorkers] = useState({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('pending');
  const [deciding, setDeciding] = useState(null);   // { row, decision }
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data, error }, { data: ws }] = await Promise.all([
      supabase.from('leave_requests').select('*').order('created_at', { ascending: false }).limit(300),
      supabase.from('workers').select('id, name, worker_type, mobile'),
    ]);
    if (error) showToast(error.message, 'error');
    setRows(data || []);
    setWorkers(Object.fromEntries((ws || []).map(w => [w.id, w])));
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const decide = async () => {
    const { row, decision } = deciding;
    setBusy(true);
    const payload = { status: decision, decided_by: currentWorker?.name || 'Office', decided_at: new Date().toISOString(), note: note.trim() || null };
    const { error } = await supabase.from('leave_requests').update(payload).eq('id', row.id).eq('status', 'pending');
    if (error) { setBusy(false); showToast(error.message, 'error'); return; }

    if (decision === 'approved') {
      const { error: uErr } = await supabase.from('worker_unavailability').insert([{
        worker_id: row.worker_id, from_date: row.from_date, to_date: row.to_date, reason: row.reason || 'Time off (approved)',
      }]);
      if (uErr) showToast(`Approved, but the Allocation Board entry failed: ${uErr.message}`, 'error');
    }

    const w = workers[row.worker_id];
    const when = row.from_date === row.to_date ? fmtDate(row.from_date) : `${fmtDate(row.from_date)} to ${fmtDate(row.to_date)}`;
    const text = decision === 'approved'
      ? `your time off ${when} is approved.${note.trim() ? ` Note: ${note.trim()}` : ''}`
      : `your time off request for ${when} was declined.${note.trim() ? ` Reason: ${note.trim()}` : ' Please call the office if you need to talk about it.'}`;
    supabase.functions.invoke('notify-worker', { body: { worker_id: row.worker_id, kind: decision === 'approved' ? 'leave_approved' : 'leave_declined', text } })
      .catch(e => console.error('notify-worker failed:', e));

    logActivity({ verb: decision, object_type: 'leave_request', object_id: row.id,
      after: { name: w?.name || row.worker_id, from_date: row.from_date, to_date: row.to_date, note: note.trim() || null } });

    setBusy(false);
    setDeciding(null); setNote('');
    showToast(`Request ${decision}${w?.name ? ` — ${w.name} has been told` : ''}.`, 'success');
    load(); refreshBadge?.();
  };

  const shown = rows.filter(r => filter === 'all' || r.status === filter);
  const counts = { pending: rows.filter(r => r.status === 'pending').length };

  return (
    <div data-area="time off requests">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, color: C.text, fontSize: 20, fontWeight: 800 }}>🏖 Time off requests</h2>
          <div style={{ color: C.textMuted, fontSize: 12.5, marginTop: 2 }}>Approved days go straight onto the Allocation Board as unavailable.</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['pending', 'approved', 'declined', 'all'].map(s => (
            <button key={s} onClick={() => setFilter(s)} style={{ ...btnSecondary, minHeight: 36, padding: '6px 12px', fontSize: 12.5,
              background: filter === s ? C.accentSoft : 'transparent', borderColor: filter === s ? C.accentBorder : C.border, color: filter === s ? C.accent : C.text }}>
              {s}{s === 'pending' && counts.pending ? ` (${counts.pending})` : ''}
            </button>
          ))}
        </div>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>
        : shown.length === 0 ? <EmptyState message={filter === 'pending' ? 'Nothing waiting — every request has an answer.' : 'No requests here.'} icon="🏖" />
        : (
          <div style={{ display: 'grid', gap: 10 }}>
            {shown.map(r => {
              const w = workers[r.worker_id];
              return (
                <div key={r.id} style={{ background: C.card, border: `1px solid ${r.status === 'pending' ? 'rgba(234,179,8,0.4)' : C.border}`, borderRadius: 10, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>{w?.name || 'Unknown worker'} <span style={{ color: C.textDim, fontSize: 12, fontWeight: 500 }}>{w?.worker_type || ''}</span></div>
                      <div style={{ color: C.text, fontSize: 13.5, marginTop: 4 }}>
                        {r.from_date === r.to_date ? fmtDate(r.from_date) : `${fmtDate(r.from_date)} → ${fmtDate(r.to_date)}`}
                      </div>
                      {r.reason && <div style={{ color: C.textMuted, fontSize: 13, marginTop: 2 }}>{r.reason}</div>}
                      <div style={{ color: C.textDim, fontSize: 11.5, marginTop: 6 }}>
                        Asked {fmtDateTime(r.created_at)}{r.decided_at ? ` · ${r.status} by ${r.decided_by || 'office'} ${fmtDateTime(r.decided_at)}` : ''}
                        {r.note ? ` · note: ${r.note}` : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {leaveBadge(r.status)}
                      {r.status === 'pending' && (
                        <>
                          <button onClick={() => { setDeciding({ row: r, decision: 'approved' }); setNote(''); }} style={{ ...btnPrimary, background: C.success, minHeight: 36, padding: '6px 14px' }}>✓ Approve</button>
                          <button onClick={() => { setDeciding({ row: r, decision: 'declined' }); setNote(''); }} style={{ ...btnDanger, minHeight: 36, padding: '6px 14px' }}>✕ Decline</button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

      {deciding && (
        <Modal title={deciding.decision === 'approved' ? 'Approve time off' : 'Decline time off'} onClose={() => setDeciding(null)} width={460}>
          <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 12 }}>
            {workers[deciding.row.worker_id]?.name || 'The worker'} · {fmtDate(deciding.row.from_date)}{deciding.row.to_date !== deciding.row.from_date ? ` → ${fmtDate(deciding.row.to_date)}` : ''}
            {deciding.decision === 'approved' ? '. The days will be marked unavailable on the Allocation Board.' : '.'}
          </div>
          <Field label={deciding.decision === 'approved' ? 'Note to the worker (optional)' : 'Reason (goes to the worker)'}>
            <input style={inputStyle} value={note} onChange={e => setNote(e.target.value)} maxLength={200} autoFocus placeholder={deciding.decision === 'approved' ? 'Enjoy the break' : 'e.g. Big pour that week, can we do the week after?'} />
          </Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={() => setDeciding(null)} style={btnSecondary}>Cancel</button>
            <button onClick={decide} disabled={busy} style={{ ...btnPrimary, background: deciding.decision === 'approved' ? C.success : C.error }}>
              {busy ? 'Saving…' : deciding.decision === 'approved' ? 'Approve' : 'Decline'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
