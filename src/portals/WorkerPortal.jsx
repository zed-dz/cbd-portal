import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary } from '../theme';
import { todayISO, fmtDate, fmtDateTime } from '../utils/dates';
import { Spinner, Modal, Field, TableWrap, Th, Td, EmptyState, allocationBadge, timesheetBadge, certBadge, DailyTimesheetForm, TimesheetDetailView } from '../components';
import { WorkerCertificateUploads } from '../components/certificates/WorkerCertificateUploads';
import { addAdminNotification, broadcastAdminSms, adminAcceptSmsBody, adminDeclineSmsBody, sendAdminEmail } from '../utils/notify';
import { roleChipStyle } from '../constants/roles';

export function WorkerPortal({ currentWorker, onSignOut, showToast, isMobile }) {
  const [activeTab, setActiveTab] = useState('allocations');

  const tabs = [
    { id: 'allocations', label: '📋 My Allocations' },
    { id: 'timesheets', label: '🕐 My Timesheets' },
    { id: 'take5', label: '✋ Take 5' },
    { id: 'profile', label: '👤 My Profile' },
    { id: 'certificates', label: '🪪 Certificates / Tickets' },
    { id: 'certifications', label: '📜 My Certifications' },
    { id: 'history', label: '🗂 History' },
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
        {activeTab === 'timesheets'     && <WorkerTimesheets currentWorker={currentWorker} showToast={showToast} onGoToTake5={() => setActiveTab('take5')} />}
        {activeTab === 'take5'          && <WorkerTake5 currentWorker={currentWorker} showToast={showToast} />}
        {activeTab === 'profile'        && <WorkerMyProfile currentWorker={currentWorker} showToast={showToast} />}
        {activeTab === 'certificates'   && <WorkerCertificateUploads workerId={currentWorker.id} showToast={showToast} canEdit />}
        {activeTab === 'certifications' && <WorkerCertifications currentWorker={currentWorker} showToast={showToast} />}
        {activeTab === 'history'        && <WorkerHistory currentWorker={currentWorker} showToast={showToast} />}
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
      ? adminAcceptSmsBody({ worker: workerName, client: clientLabel, start_date: a.start_date, role: a.role })
      : adminDeclineSmsBody({ worker: workerName, client: clientLabel, start_date: a.start_date, role: a.role });
    broadcastAdminSms(smsBody);
    sendAdminEmail(
      `${workerName} ${verb} — ${clientLabel || 'allocation'}`,
      `${workerName} has ${decision === 'accept' ? 'ACCEPTED' : 'DECLINED'} the allocation for ${clientLabel || 'a job'}${a.role ? ` as ${a.role}` : ''}${a.start_date ? ` (${a.start_date})` : ''}.`
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
          {a.role && <div style={{ marginBottom: 8 }}><span style={roleChipStyle(a.role)}>{a.role}</span></div>}
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

function WorkerTimesheets({ currentWorker, showToast, onGoToTake5 }) {
  const [headers, setHeaders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [viewing, setViewing] = useState(null);      // { header, lines } for the full view
  const [viewLoading, setViewLoading] = useState(false);

  // Full view of one submitted timesheet — shareable with a client via Print/PDF.
  const openView = async (h) => {
    setViewLoading(true);
    setViewing({ header: h, lines: [] });
    const { data, error } = await supabase.from('timesheets').select('*')
      .eq('header_id', h.id).order('date');
    if (error) showToast(error.message, 'error');
    setViewing({ header: h, lines: data || [] });
    setViewLoading(false);
  };

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
            <thead><tr><Th>Submitted</Th><Th>Client</Th><Th>Project</Th><Th>Role</Th><Th>Total Hrs</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>
              {headers.map(h => (
                <tr key={h.id}>
                  <Td>{fmtDate(h.created_at)}</Td>
                  <Td>{h.client || '—'}</Td>
                  <Td>{h.project || '—'}</Td>
                  <Td>{h.role || '—'}</Td>
                  <Td>{Number(h.total_hours || 0).toFixed(2)}</Td>
                  <Td>{timesheetBadge(h.status)}</Td>
                  <Td><button onClick={() => openView(h)} style={{ ...btnSecondary, padding: '5px 12px', fontSize: 12 }}>View</button></Td>
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
            onGoToTake5={() => { setModal(false); onGoToTake5?.(); }}
          />
        </Modal>
      )}

      {viewing && (
        <Modal title="My Timesheet" onClose={() => setViewing(null)} width={880}>
          {viewLoading
            ? <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner /></div>
            : <TimesheetDetailView
                header={viewing.header}
                lines={viewing.lines}
                workerName={currentWorker?.name}
                onClose={() => setViewing(null)}
              />}
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
      <ChangePassword showToast={showToast} />
    </div>
  );
}

// Lets a worker set/replace their own password — the missing piece that left
// magic-link users stuck on "Invalid login credentials" forever (they could
// get in via the emailed link but never establish a password they knew).
function ChangePassword({ showToast }) {
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (pw1.length < 8) { showToast('Password must be at least 8 characters.', 'error'); return; }
    if (pw1 !== pw2) { showToast('Passwords do not match.', 'error'); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw1 });
    setBusy(false);
    if (error) { showToast(error.message, 'error'); return; }
    setPw1(''); setPw2('');
    showToast('Password updated — use it next time you sign in.', 'success');
  };

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: '16px 18px', marginTop: 8 }}>
      <div style={{ fontWeight: 700, color: C.text, fontSize: 14, marginBottom: 4 }}>🔑 Change password</div>
      <div style={{ color: C.textMuted, fontSize: 12, marginBottom: 12 }}>
        Signed in with an emailed link? Set a password here so you can sign in normally next time.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
        <Field label="New password"><input style={inputStyle} type="password" value={pw1} onChange={e => setPw1(e.target.value)} placeholder="••••••••" autoComplete="new-password" /></Field>
        <Field label="Confirm new password"><input style={inputStyle} type="password" value={pw2} onChange={e => setPw2(e.target.value)} placeholder="••••••••" autoComplete="new-password" /></Field>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? 'Saving…' : 'Update password'}</button>
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

const PPE_ITEMS = ['Hard hat', 'Hi-vis clothing', 'Steel-cap boots', 'Safety glasses', 'Gloves', 'Hearing protection', 'Dust mask / respirator', 'Sunscreen'];

const HAZARD_SUGGESTIONS = [
  'Moving plant / machinery', 'Live traffic', 'Working at heights', 'Manual handling',
  'Overhead powerlines', 'Underground services', 'Noise', 'Dust / silica',
  'Sun / UV exposure', 'Slips, trips and falls', 'Crush / pinch points', 'Fatigue',
  'Hot works', 'Confined space', 'Weather (wind / rain / lightning)', 'Public / pedestrians',
];

const emptyTaskHazard = () => ({ hazard: '', control: '' });
const blankTake5 = () => ({
  work_date: todayISO(), site: '', task: '',
  task_hazards: [emptyTaskHazard(), emptyTaskHazard()],
  ppe: [], acknowledged: false,
});

// Pre-start Take 5 safety check. Required on Tue/Thu before a timesheet can be
// submitted (the gate lives in DailyTimesheetForm; this writes the take5 row).
// The worker states the TASK they're doing, then picks 2–3 hazards specific to
// that task, each with its control measure.
function WorkerTake5({ currentWorker, showToast }) {
  const [f, setF] = useState(blankTake5());
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data } = await supabase.from('take5').select('*')
      .eq('worker_id', currentWorker.id).order('created_at', { ascending: false }).limit(15);
    setRecent(data || []);
    setLoading(false);
  }, [currentWorker.id]);
  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));
  const togglePpe = (item) => setF(s => ({ ...s, ppe: s.ppe.includes(item) ? s.ppe.filter(x => x !== item) : [...s.ppe, item] }));
  const setHazard = (idx, key, value) => setF(s => ({
    ...s, task_hazards: s.task_hazards.map((h, i) => i === idx ? { ...h, [key]: value } : h),
  }));
  const addHazard = () => setF(s => s.task_hazards.length >= 3 ? s : ({ ...s, task_hazards: [...s.task_hazards, emptyTaskHazard()] }));
  const removeHazard = (idx) => setF(s => ({
    ...s, task_hazards: s.task_hazards.length > 1 ? s.task_hazards.filter((_, i) => i !== idx) : s.task_hazards,
  }));

  const submit = async () => {
    if (!String(f.task).trim()) { showToast('Describe the task you are about to do.', 'error'); return; }
    const filled = f.task_hazards.filter(h => String(h.hazard).trim());
    if (filled.length < 2) { showToast('Pick at least 2 hazards for this task (add a third if it applies).', 'error'); return; }
    if (filled.some(h => !String(h.control).trim())) { showToast('Add a control measure for each hazard.', 'error'); return; }
    if (!f.acknowledged) { showToast('Please tick the acknowledgement to submit your Take 5.', 'error'); return; }
    setSaving(true);
    const { error } = await supabase.from('take5').insert([{
      worker_id: currentWorker.id,
      work_date: f.work_date,
      site: f.site || null,
      task: f.task,
      task_hazards: filled,
      // legacy text columns stay populated so older views/reports keep working
      hazards: filled.map(h => h.hazard).join('; '),
      controls: filled.map(h => h.control).join('; '),
      ppe: f.ppe,
      acknowledged: f.acknowledged,
    }]);
    setSaving(false);
    if (error) { showToast(error.message, 'error'); return; }
    showToast('Take 5 submitted — you can now submit your timesheet for this day.', 'success');
    setF(blankTake5());
    load();
  };

  const steps = [
    ['1 · Stop & Think', 'Pause before you start. Are you fit, focused and clear on the task?'],
    ['2 · Look', 'Identify the hazards around you — people, plant, energy, environment.'],
    ['3 · Assess', 'Assess each hazard: what could go wrong, and how badly?'],
    ['4 · Control', 'Put controls in place to remove or reduce each risk.'],
    ['5 · Proceed safely', 'Only start once controls are in place. Re-do a Take 5 if the job changes.'],
  ];

  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 640, margin: '0 auto' }}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20 }}>
        <div style={{ fontWeight: 700, color: C.text, fontSize: 16, marginBottom: 4 }}>✋ Take 5 — pre-start safety check</div>
        <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 14 }}>Required on Tuesdays &amp; Thursdays before you can submit a timesheet. Takes about a minute.</div>
        <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
          {steps.map(([t, d]) => (
            <div key={t} style={{ display: 'flex', gap: 10 }}>
              <div style={{ color: C.accent, fontWeight: 700, fontSize: 13, minWidth: 120 }}>{t}</div>
              <div style={{ color: C.textMuted, fontSize: 13 }}>{d}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
          <Field label="Date"><input type="date" style={inputStyle} value={f.work_date} onChange={set('work_date')} /></Field>
          <Field label="Client / site"><input style={inputStyle} value={f.site} onChange={set('site')} placeholder="Where are you working?" /></Field>
        </div>
        <Field label="What task are you doing? *" hint="The specific job you're about to start — e.g. operating the roller on the access road.">
          <input style={inputStyle} value={f.task} onChange={set('task')} placeholder="e.g. Operating dozer for bulk earthworks" />
        </Field>
        <Field label="Hazards for this task * (pick 2–3, with your control for each)">
          <div style={{ display: 'grid', gap: 8 }}>
            {f.task_hazards.map((h, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 180px', minWidth: 160 }}>
                  <input style={inputStyle} list="take5-hazards" value={h.hazard}
                    onChange={e => setHazard(i, 'hazard', e.target.value)}
                    placeholder={`Hazard ${i + 1} — pick or type`} />
                </div>
                <div style={{ flex: '1 1 220px', minWidth: 180 }}>
                  <input style={inputStyle} value={h.control}
                    onChange={e => setHazard(i, 'control', e.target.value)}
                    placeholder="Control measure — how you'll manage it" />
                </div>
                {f.task_hazards.length > 1 && (
                  <button type="button" onClick={() => removeHazard(i)}
                    style={{ ...btnSecondary, padding: '9px 12px', color: '#fca5a5', borderColor: 'rgba(239,68,68,0.32)' }}>×</button>
                )}
              </div>
            ))}
            <datalist id="take5-hazards">{HAZARD_SUGGESTIONS.map(h => <option key={h} value={h} />)}</datalist>
            {f.task_hazards.length < 3 && (
              <button type="button" onClick={addHazard} style={{ ...btnSecondary, padding: '7px 14px', fontSize: 12, justifySelf: 'start', width: 'fit-content' }}>+ Add another hazard</button>
            )}
          </div>
        </Field>
        <Field label="PPE for this task">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {PPE_ITEMS.map(item => (
              <label key={item} style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.text, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={f.ppe.includes(item)} onChange={() => togglePpe(item)} /> {item}
              </label>
            ))}
          </div>
        </Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.text, fontSize: 14, cursor: 'pointer', margin: '12px 0' }}>
          <input type="checkbox" checked={f.acknowledged} onChange={e => setF(s => ({ ...s, acknowledged: e.target.checked }))} />
          I've completed this Take 5 and it's safe to proceed.
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={submit} disabled={saving} style={btnPrimary}>{saving ? 'Submitting…' : 'Submit Take 5'}</button>
        </div>
      </div>

      <div>
        <h4 style={{ color: C.textMuted, fontSize: 13, marginBottom: 10, textTransform: 'uppercase' }}>Recent Take 5s</h4>
        {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 20 }}><Spinner /></div> : recent.length === 0 ? <EmptyState message="No Take 5s submitted yet." /> : (
          <TableWrap>
            <thead><tr><Th>Date</Th><Th>Site</Th><Th>Task</Th><Th>Hazards</Th><Th>Submitted</Th></tr></thead>
            <tbody>
              {recent.map(t => (
                <tr key={t.id}>
                  <Td>{fmtDate(t.work_date)}</Td>
                  <Td>{t.site || '—'}</Td>
                  <Td>{t.task ? (t.task.length > 36 ? t.task.slice(0, 36) + '…' : t.task) : '—'}</Td>
                  <Td>{t.hazards ? (t.hazards.length > 44 ? t.hazards.slice(0, 44) + '…' : t.hazards) : '—'}</Td>
                  <Td>{fmtDateTime(t.created_at)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </div>
    </div>
  );
}

// Read-only history of every timesheet the worker has submitted, incl. the
// Tasks Completed text they logged. Newest first.
function WorkerHistory({ currentWorker, showToast }) {
  const [headers, setHeaders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data, error } = await supabase.from('timesheet_headers').select('*')
        .eq('worker_id', currentWorker.id).order('created_at', { ascending: false });
      if (!mounted) return;
      if (error) showToast(error.message, 'error');
      else setHeaders(data || []);
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [currentWorker.id, showToast]);

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;
  if (!headers.length) return <EmptyState message="No timesheets submitted yet." />;

  return (
    <div>
      <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 14 }}>A read-only record of every timesheet you've submitted, newest first.</div>
      <TableWrap>
        <thead><tr><Th>Submitted</Th><Th>Client</Th><Th>Project</Th><Th>Role</Th><Th>Total Hrs</Th><Th>Status</Th><Th>Tasks Completed</Th></tr></thead>
        <tbody>
          {headers.map(h => (
            <tr key={h.id}>
              <Td>{fmtDate(h.created_at)}</Td>
              <Td>{h.client || '—'}</Td>
              <Td>{h.project || '—'}</Td>
              <Td>{h.role || '—'}</Td>
              <Td>{Number(h.total_hours || 0).toFixed(2)}</Td>
              <Td>{timesheetBadge(h.status)}</Td>
              <Td>{h.comments ? h.comments : '—'}</Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </div>
  );
}
