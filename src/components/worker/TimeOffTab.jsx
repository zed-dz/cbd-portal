import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary } from '../../theme';
import { todayISO, fmtDate, fmtDateTime } from '../../utils/dates';
import { Field, Spinner, EmptyState, Badge } from '../index';

// Time off / unavailability requests from the phone (2026-10-19). The worker
// asks for a date range with a short reason; the office approves or declines
// on the "Time off requests" page, which also writes worker_unavailability so
// the Allocation Board greys the days out. The decision shows here (and goes
// out by SMS / email through notify-worker) — a bell row is admin-only.

const REASON_MAX = 80;

export function leaveBadge(status) {
  const map = { pending: 'yellow', approved: 'green', declined: 'red' };
  return <Badge label={status} color={map[status] || 'gray'} />;
}

export function TimeOffTab({ currentWorker, showToast }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('leave_requests').select('*')
      .eq('worker_id', currentWorker.id).order('created_at', { ascending: false }).limit(50);
    if (error) showToast(error.message, 'error');
    setRows(data || []);
    setLoading(false);
  }, [currentWorker.id, showToast]);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    const f = from, t = to || from;
    if (!f) { showToast('Pick the first day off.', 'error'); return; }
    if (t < f) { showToast('The last day cannot be before the first day.', 'error'); return; }
    if (f < todayISO()) { showToast('Time off in the past cannot be requested — tell the office instead.', 'error'); return; }
    setSaving(true);
    const { data, error } = await supabase.from('leave_requests').insert([{
      worker_id: currentWorker.id, from_date: f, to_date: t, reason: reason.trim().slice(0, REASON_MAX) || null, status: 'pending',
    }]).select().single();
    setSaving(false);
    if (error) { showToast(error.message, 'error'); return; }
    // Bell + SMS + email to the office, built server-side from the row.
    supabase.functions.invoke('notify-admins-ops', { body: { kind: 'leave_requested', id: data.id } })
      .catch(e => console.error('notify-admins-ops failed:', e));
    showToast('Request sent — the office will approve or decline it.', 'success');
    setFrom(''); setTo(''); setReason('');
    load();
  };

  const niceRange = (r) => r.from_date === r.to_date ? fmtDate(r.from_date) : `${fmtDate(r.from_date)} → ${fmtDate(r.to_date)}`;

  return (
    <div data-area="time off" style={{ display: 'grid', gap: 16, maxWidth: 640, margin: '0 auto' }}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18 }}>
        <div style={{ fontWeight: 700, color: C.text, fontSize: 16, marginBottom: 4 }}>🏖 Request time off</div>
        <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 14 }}>
          Holidays, appointments, days you cannot work. The office answers here and by text.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0 12px' }}>
          <Field label="First day off *"><input type="date" style={inputStyle} value={from} min={todayISO()} onChange={e => { setFrom(e.target.value); if (!to || to < e.target.value) setTo(e.target.value); }} /></Field>
          <Field label="Last day off"><input type="date" style={inputStyle} value={to} min={from || todayISO()} onChange={e => setTo(e.target.value)} /></Field>
        </div>
        <Field label={`Reason (${reason.length}/${REASON_MAX})`}>
          <input style={inputStyle} value={reason} maxLength={REASON_MAX} onChange={e => setReason(e.target.value)} placeholder="e.g. Family holiday, dentist, moving house" />
        </Field>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={submit} disabled={saving} style={{ ...btnPrimary, minHeight: 40 }}>{saving ? 'Sending…' : 'Send request'}</button>
        </div>
      </div>

      <div>
        <h4 style={{ color: C.textMuted, fontSize: 13, marginBottom: 10, textTransform: 'uppercase' }}>My requests</h4>
        {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 20 }}><Spinner /></div>
          : rows.length === 0 ? <EmptyState message="No time off requested yet." icon="🏖" />
          : rows.map(r => (
            <div key={r.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 700, color: C.text, fontSize: 14 }}>{niceRange(r)}</div>
                {leaveBadge(r.status)}
              </div>
              {r.reason && <div style={{ color: C.textMuted, fontSize: 13, marginTop: 4 }}>{r.reason}</div>}
              <div style={{ color: C.textDim, fontSize: 11.5, marginTop: 6 }}>
                Sent {fmtDateTime(r.created_at)}
                {r.decided_at && ` · ${r.status} by ${r.decided_by || 'the office'} ${fmtDateTime(r.decided_at)}`}
              </div>
              {r.note && <div style={{ marginTop: 6, fontSize: 12.5, color: r.status === 'declined' ? '#fca5a5' : C.text, background: C.bg, borderRadius: 6, padding: '6px 10px' }}>Office: {r.note}</div>}
            </div>
          ))}
      </div>
    </div>
  );
}
