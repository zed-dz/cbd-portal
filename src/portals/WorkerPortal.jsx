import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary } from '../theme';
import { todayISO, fmtDate, fmtDateTime } from '../utils/dates';
import { Spinner, Modal, Field, TableWrap, Th, Td, EmptyState, allocationBadge, timesheetBadge, certBadge, DailyTimesheetForm } from '../components';
import { WorkerCertificateUploads } from '../components/certificates/WorkerCertificateUploads';
import { addAdminNotification, broadcastAdminSms, adminAcceptSmsBody, adminDeclineSmsBody, sendAdminEmail } from '../utils/notify';

export function WorkerPortal({ currentWorker, onSignOut, showToast, isMobile }) {
  const [activeTab, setActiveTab] = useState('allocations');

  const tabs = [
    { id: 'allocations', label: '📋 My Allocations' },
    { id: 'timesheets', label: '🕐 My Timesheets' },
    { id: 'profile', label: '👤 My Profile' },
    { id: 'certificates', label: '🪪 Certificates / Tickets' },
    { id: 'certifications', label: '📜 My Certifications' },
    { id: 'clockin', label: '⏱ Clock In/Out' },
  ];

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '0 20px', height: 56, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>CBD Plant & Labour</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: C.textMuted, fontSize: 13 }}>👤 {currentWorker?.name}</span>
          <button onClick={onSignOut} style={{ ...btnSecondary, padding: '6px 14px', fontSize: 13 }}>Sign Out</button>
        </div>
      </div>

      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, overflowX: 'auto', display: 'flex' }}>
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
            padding: '14px 20px', background: 'none', border: 'none', cursor: 'pointer',
            color: activeTab === tab.id ? C.accent : C.textMuted, fontSize: 14, fontWeight: activeTab === tab.id ? 600 : 400,
            borderBottom: `2px solid ${activeTab === tab.id ? C.accent : 'transparent'}`, whiteSpace: 'nowrap', transition: 'all 0.15s',
          }}>
            {tab.label}
          </button>
        ))}
      </div>

      <div style={{ padding: isMobile ? 12 : 24, maxWidth: 900, margin: '0 auto' }}>
        {activeTab === 'allocations'    && <WorkerAllocations currentWorker={currentWorker} showToast={showToast} />}
        {activeTab === 'timesheets'     && <WorkerTimesheets currentWorker={currentWorker} showToast={showToast} />}
        {activeTab === 'profile'        && <WorkerMyProfile currentWorker={currentWorker} showToast={showToast} />}
        {activeTab === 'certificates'   && <WorkerCertificateUploads workerId={currentWorker.id} showToast={showToast} canEdit />}
        {activeTab === 'certifications' && <WorkerCertifications currentWorker={currentWorker} showToast={showToast} />}
        {activeTab === 'clockin'        && <WorkerClockIn currentWorker={currentWorker} showToast={showToast} />}
      </div>
    </div>
  );
}

function WorkerAllocations({ currentWorker, showToast }) {
  const [allocations, setAllocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(null);   // allocation id currently being accepted/declined

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('allocations').select('*').eq('worker_id', currentWorker.id).order('created_at', { ascending: false });
    if (error) showToast(error.message, 'error');
    else setAllocations(data || []);
    setLoading(false);
  }, [currentWorker.id, showToast]);

  useEffect(() => { load(); }, [load]);

  // Worker responds to a pending allocation. accept → confirmed, decline → declined.
  // Updates the row, then drops an admin notification so the bell lights up.
  const respond = async (a, decision) => {
    const newStatus = decision === 'accept' ? 'confirmed' : 'declined';
    setActing(a.id);
    const { error } = await supabase.from('allocations').update({ status: newStatus }).eq('id', a.id);
    if (error) {
      showToast(error.message, 'error');
      setActing(null);
      return;
    }
    // Optimistic local update.
    setAllocations(prev => prev.map(x => (x.id === a.id ? { ...x, status: newStatus } : x)));
    const verb = decision === 'accept' ? 'ACCEPTED' : 'DECLINED';
    const where = a.client || a.site || 'a job';
    addAdminNotification({
      type: decision === 'accept' ? 'allocation_accepted' : 'allocation_declined',
      title: `${currentWorker?.name || 'Worker'} ${verb} ${where}`,
      body: `${a.client || a.site || ''}${a.start_date ? ` — ${a.start_date}` : ''}`.trim() || null,
      allocation_id: a.id,
      worker_id: currentWorker.id,
    });

    // Broadcast the response to every admin by SMS + email. Fire-and-forget.
    const workerName = currentWorker?.name || 'Worker';
    const clientLabel = a.client || a.site || '';
    const smsBody = decision === 'accept'
      ? adminAcceptSmsBody({ worker: workerName, client: clientLabel, start_date: a.start_date })
      : adminDeclineSmsBody({ worker: workerName, client: clientLabel, start_date: a.start_date });
    broadcastAdminSms(smsBody);
    sendAdminEmail(
      `${workerName} ${verb} — ${clientLabel || 'allocation'}`,
      `${workerName} has ${decision === 'accept' ? 'ACCEPTED' : 'DECLINED'} the allocation for ${clientLabel || 'a job'}${a.start_date ? ` (${a.start_date})` : ''}.`
    );

    showToast(decision === 'accept' ? 'Allocation accepted — thanks!' : 'Allocation declined.', decision === 'accept' ? 'success' : 'info');
    setActing(null);
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;
  if (!allocations.length) return <EmptyState message="No allocations found." />;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
      {allocations.map(a => (
        <div key={a.id} style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>{a.site || 'No site'}</div>
            {allocationBadge(a.status)}
          </div>
          <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 4 }}>Client: {a.client || '—'}</div>
          {a.project && <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 4 }}>Project: {a.project}</div>}
          {a.address && <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 4 }}>Address: {a.address}</div>}
          {a.site_manager && <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 4 }}>Site Supervisor: {a.site_manager}{a.manager_phone ? ` · ${a.manager_phone}` : ''}</div>}
          {a.start_date && <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 4 }}>Date: {a.start_date}</div>}
          <div style={{ color: C.textMuted, fontSize: 13 }}>Start: {fmtDateTime(a.start_time)}</div>
          {a.notes && <div style={{ color: C.textMuted, fontSize: 12, marginTop: 10, fontStyle: 'italic' }}>{a.notes}</div>}

          {a.status === 'pending' && (
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button
                onClick={() => respond(a, 'accept')}
                disabled={acting === a.id}
                style={{ ...btnPrimary, flex: 1, background: C.success, opacity: acting === a.id ? 0.6 : 1 }}
              >
                {acting === a.id ? '…' : '✓ Accept'}
              </button>
              <button
                onClick={() => respond(a, 'decline')}
                disabled={acting === a.id}
                style={{ ...btnSecondary, flex: 1, color: '#fca5a5', borderColor: 'rgba(239,68,68,0.32)', opacity: acting === a.id ? 0.6 : 1 }}
              >
                ✕ Decline
              </button>
            </div>
          )}
          {a.status === 'confirmed' && (
            <div style={{ marginTop: 12, fontSize: 12, color: C.success, fontWeight: 600 }}>✓ You accepted this allocation</div>
          )}
          {a.status === 'declined' && (
            <div style={{ marginTop: 12, fontSize: 12, color: '#fca5a5', fontWeight: 600 }}>✕ You declined this allocation</div>
          )}
        </div>
      ))}
    </div>
  );
}

function WorkerTimesheets({ currentWorker, showToast }) {
  const [headers, setHeaders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('timesheet_headers').select('*')
      .eq('worker_id', currentWorker.id).order('created_at', { ascending: false });
    if (error) showToast(error.message, 'error');
    else setHeaders(data || []);
    setLoading(false);
  }, [currentWorker.id, showToast]);

  useEffect(() => { load(); }, [load]);

  const onSaved = () => { setModal(false); load(); };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
        <button onClick={() => setModal(true)} style={btnPrimary}>+ New Daily Timesheet</button>
      </div>
      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : headers.length === 0 ? (
        <EmptyState message="No timesheets yet. Submit one to get started." />
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            {['all','pending','approved','rejected'].map(s => {
              const hrs = (s === 'all' ? headers : headers.filter(t => t.status === s)).reduce((a, t) => a + (parseFloat(t.total_hours) || 0), 0);
              return (
                <div key={s} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 16px', textAlign: 'center' }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: s === 'approved' ? C.success : s === 'rejected' ? C.error : s === 'pending' ? C.warning : C.text }}>{hrs.toFixed(1)}</div>
                  <div style={{ color: C.textMuted, fontSize: 11, textTransform: 'uppercase' }}>{s} hrs</div>
                </div>
              );
            })}
          </div>
          <TableWrap>
            <thead><tr><Th>Submitted</Th><Th>Client</Th><Th>Project</Th><Th>Role</Th><Th>Total Hrs</Th><Th>Status</Th></tr></thead>
            <tbody>
              {headers.map(h => (
                <tr key={h.id}>
                  <Td>{fmtDate(h.created_at)}</Td>
                  <Td>{h.client || '—'}</Td>
                  <Td>{h.project || '—'}</Td>
                  <Td>{h.role || '—'}</Td>
                  <Td>{Number(h.total_hours || 0).toFixed(2)}</Td>
                  <Td>{timesheetBadge(h.status)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </>
      )}

      {modal && (
        <Modal title="Daily Timesheet" onClose={() => setModal(false)} width={780}>
          <DailyTimesheetForm
            workerId={currentWorker.id}
            onSaved={onSaved}
            onCancel={() => setModal(false)}
            showToast={showToast}
          />
        </Modal>
      )}
    </div>
  );
}

function WorkerMyProfile({ currentWorker, showToast }) {
  const [f, setF] = useState({
    mobile: currentWorker.mobile || '',
    alternate_phone: currentWorker.alternate_phone || '',
    address: currentWorker.address || '',
    postal_address: currentWorker.postal_address || '',
    drivers_licence_number: currentWorker.drivers_licence_number || '',
    drivers_licence_expiry: currentWorker.drivers_licence_expiry || '',
    licences: currentWorker.licences || '',
    emergency_name: currentWorker.emergency_name || '',
    emergency_relationship: currentWorker.emergency_relationship || '',
    emergency_phone: currentWorker.emergency_phone || '',
    emergency_phone_alt: currentWorker.emergency_phone_alt || '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const save = async () => {
    setSaving(true);
    const { data, error } = await supabase.rpc('update_my_worker_profile', {
      p_mobile: f.mobile,
      p_alternate_phone: f.alternate_phone,
      p_address: f.address,
      p_postal_address: f.postal_address,
      p_drivers_licence_number: f.drivers_licence_number,
      p_drivers_licence_expiry: f.drivers_licence_expiry || null,
      p_licences: f.licences,
      p_emergency_name: f.emergency_name,
      p_emergency_relationship: f.emergency_relationship,
      p_emergency_phone: f.emergency_phone,
      p_emergency_phone_alt: f.emergency_phone_alt,
    });
    setSaving(false);
    if (error || data === false) showToast(error?.message || 'Could not save profile', 'error');
    else showToast('Profile updated', 'success');
  };

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', display: 'grid', gap: 12 }}>
      <div style={{ color: C.textMuted, fontSize: 13 }}>
        Keep these up to date — new tickets, a house move, or a new phone number.
      </div>
      <Field label="Mobile"><input style={inputStyle} value={f.mobile} onChange={set('mobile')} /></Field>
      <Field label="Alternate phone"><input style={inputStyle} value={f.alternate_phone} onChange={set('alternate_phone')} /></Field>
      <Field label="Residential address"><input style={inputStyle} value={f.address} onChange={set('address')} /></Field>
      <Field label="Postal address"><input style={inputStyle} value={f.postal_address} onChange={set('postal_address')} /></Field>
      <Field label="Tickets / licences (White Card, HR licence, EWP…)">
        <textarea style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} value={f.licences} onChange={set('licences')} />
      </Field>
      <Field label="Driver licence number"><input style={inputStyle} value={f.drivers_licence_number} onChange={set('drivers_licence_number')} /></Field>
      <Field label="Driver licence expiry"><input style={inputStyle} type="date" value={f.drivers_licence_expiry || ''} onChange={set('drivers_licence_expiry')} /></Field>
      <Field label="Emergency contact name"><input style={inputStyle} value={f.emergency_name} onChange={set('emergency_name')} /></Field>
      <Field label="Emergency contact relationship"><input style={inputStyle} value={f.emergency_relationship} onChange={set('emergency_relationship')} /></Field>
      <Field label="Emergency contact phone"><input style={inputStyle} value={f.emergency_phone} onChange={set('emergency_phone')} /></Field>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={save} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save profile'}</button>
      </div>
    </div>
  );
}

function WorkerCertifications({ currentWorker, showToast }) {
  const [certs, setCerts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data, error } = await supabase.from('certifications').select('*').eq('worker_id', currentWorker.id).order('expiry', { ascending: true });
      if (!mounted) return;
      if (error) showToast(error.message, 'error');
      else setCerts(data || []);
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [currentWorker.id, showToast]);

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;
  if (!certs.length) return <EmptyState message="No certifications on file." />;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
      {certs.map(c => (
        <div key={c.id} style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
            <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>{c.cert_name}</div>
            {certBadge(c.expiry)}
          </div>
          {c.issuer && <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 4 }}>Issuer: {c.issuer}</div>}
          <div style={{ color: C.textMuted, fontSize: 13 }}>Expiry: {fmtDate(c.expiry)}</div>
        </div>
      ))}
    </div>
  );
}

function WorkerClockIn({ currentWorker, showToast }) {
  const [now, setNow] = useState(new Date());
  const storageKey = `clockIn_${currentWorker.id}`;
  const [clockInTime, setClockInTime] = useState(() => {
    const stored = localStorage.getItem(storageKey);
    return stored ? new Date(stored) : null;
  });
  const [saving, setSaving] = useState(false);
  const [todayEntries, setTodayEntries] = useState([]);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const loadToday = useCallback(async () => {
    const { data } = await supabase.from('timesheets').select('*')
      .eq('worker_id', currentWorker.id)
      .eq('date', todayISO())
      .order('created_at', { ascending: false });
    setTodayEntries(data || []);
  }, [currentWorker.id]);

  useEffect(() => { loadToday(); }, [loadToday]);

  const handleClockIn = () => {
    const t = new Date();
    setClockInTime(t);
    localStorage.setItem(storageKey, t.toISOString());
    showToast(`Clocked in at ${t.toLocaleTimeString('en-AU', { timeStyle: 'short' })}`, 'success');
  };

  const handleClockOut = async () => {
    if (!clockInTime) return;
    const out = new Date();
    const hours = Math.round(((out - clockInTime) / (1000 * 60 * 60)) * 100) / 100;
    setSaving(true);
    const { error } = await supabase.from('timesheets').insert([{
      worker_id: currentWorker.id,
      date: todayISO(),
      start_time: clockInTime.toISOString(),
      end_time: out.toISOString(),
      hours,
      status: 'pending',
    }]);
    if (error) { showToast(error.message, 'error'); }
    else {
      showToast(`Clocked out — ${hours} hours logged`, 'success');
      localStorage.removeItem(storageKey);
      setClockInTime(null);
      loadToday();
    }
    setSaving(false);
  };

  const elapsed = clockInTime ? Math.floor((now - clockInTime) / 1000) : 0;
  const elapsedStr = clockInTime ? `${String(Math.floor(elapsed / 3600)).padStart(2, '0')}:${String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}` : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 24 }}>
      <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, padding: '32px 40px', textAlign: 'center', maxWidth: 380, width: '100%' }}>
        <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 8 }}>{now.toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
        <div style={{ fontSize: 44, fontWeight: 800, color: C.text, fontVariantNumeric: 'tabular-nums', letterSpacing: 2 }}>
          {now.toLocaleTimeString('en-AU', { timeStyle: 'medium' })}
        </div>

        {clockInTime && (
          <div style={{ marginTop: 16, padding: '8px 16px', background: '#16653a', borderRadius: 8 }}>
            <div style={{ color: '#4ade80', fontSize: 13 }}>Clocked in at {clockInTime.toLocaleTimeString('en-AU', { timeStyle: 'short' })}</div>
            <div style={{ color: '#4ade80', fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{elapsedStr}</div>
          </div>
        )}

        <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!clockInTime ? (
            <button onClick={handleClockIn} style={{ ...btnPrimary, background: C.success, fontSize: 16, padding: '14px 0', borderRadius: 8 }}>
              ▶ Clock In
            </button>
          ) : (
            <button onClick={handleClockOut} disabled={saving} style={{ ...btnPrimary, background: C.error, fontSize: 16, padding: '14px 0', borderRadius: 8 }}>
              {saving ? 'Saving…' : '■ Clock Out'}
            </button>
          )}
        </div>
      </div>

      {todayEntries.length > 0 && (
        <div style={{ marginTop: 28, width: '100%', maxWidth: 380 }}>
          <h4 style={{ color: C.textMuted, fontSize: 13, marginBottom: 12, textTransform: 'uppercase' }}>Today's entries</h4>
          {todayEntries.map(e => (
            <div key={e.id} style={{ background: C.card, borderRadius: 8, border: `1px solid ${C.border}`, padding: '12px 16px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ color: C.text, fontWeight: 600 }}>{e.hours} hrs</span>
                {e.start_time && <span style={{ color: C.textMuted, fontSize: 12, marginLeft: 8 }}>{fmtDateTime(e.start_time)} → {fmtDateTime(e.end_time)}</span>}
              </div>
              {timesheetBadge(e.status)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
