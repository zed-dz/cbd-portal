import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary } from '../theme';
import { todayISO, fmtDate, fmtDateTime } from '../utils/dates';
import { Spinner, Modal, Field, TableWrap, Th, Td, EmptyState, allocationBadge, timesheetBadge, certBadge } from '../components';

export function WorkerPortal({ currentWorker, onSignOut, showToast, isMobile }) {
  const [activeTab, setActiveTab] = useState('allocations');

  const tabs = [
    { id: 'allocations', label: '📋 My Allocations' },
    { id: 'timesheets', label: '🕐 My Timesheets' },
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
        {activeTab === 'certifications' && <WorkerCertifications currentWorker={currentWorker} showToast={showToast} />}
        {activeTab === 'clockin'        && <WorkerClockIn currentWorker={currentWorker} showToast={showToast} />}
      </div>
    </div>
  );
}

function WorkerAllocations({ currentWorker, showToast }) {
  const [allocations, setAllocations] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data, error } = await supabase.from('allocations').select('*').eq('worker_id', currentWorker.id).order('created_at', { ascending: false });
      if (!mounted) return;
      if (error) showToast(error.message, 'error');
      else setAllocations(data || []);
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [currentWorker.id, showToast]);

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
          {a.site_manager && <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 4 }}>Site Manager: {a.site_manager}{a.manager_phone ? ` · ${a.manager_phone}` : ''}</div>}
          {a.start_date && <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 4 }}>Date: {a.start_date}</div>}
          <div style={{ color: C.textMuted, fontSize: 13 }}>Start: {fmtDateTime(a.start_time)}</div>
          {a.notes && <div style={{ color: C.textMuted, fontSize: 12, marginTop: 10, fontStyle: 'italic' }}>{a.notes}</div>}
        </div>
      ))}
    </div>
  );
}

function WorkerTimesheets({ currentWorker, showToast }) {
  const [timesheets, setTimesheets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ client: '', site: '', date: todayISO(), hours: '', notes: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('timesheets').select('*').eq('worker_id', currentWorker.id).order('date', { ascending: false });
    if (error) showToast(error.message, 'error');
    else setTimesheets(data || []);
    setLoading(false);
  }, [currentWorker.id, showToast]);

  useEffect(() => { load(); }, [load]);

  const handleSubmit = async () => {
    if (!form.date || form.hours === '') { showToast('Date and hours are required.', 'error'); return; }
    setSaving(true);
    const { error } = await supabase.from('timesheets').insert([{ ...form, worker_id: currentWorker.id, status: 'pending', hours: parseFloat(form.hours) }]);
    if (error) showToast(error.message, 'error');
    else { showToast('Timesheet submitted successfully', 'success'); setModal(false); setForm({ client: '', site: '', date: todayISO(), hours: '', notes: '' }); load(); }
    setSaving(false);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
        <button onClick={() => setModal(true)} style={btnPrimary}>+ Submit Timesheet</button>
      </div>
      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : timesheets.length === 0 ? (
        <EmptyState message="No timesheets yet. Submit one to get started." />
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            {['all','pending','approved','rejected'].map(s => {
              const hrs = (s === 'all' ? timesheets : timesheets.filter(t => t.status === s)).reduce((a, t) => a + (parseFloat(t.hours) || 0), 0);
              return (
                <div key={s} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 16px', textAlign: 'center' }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: s === 'approved' ? C.success : s === 'rejected' ? C.error : s === 'pending' ? C.warning : C.text }}>{hrs.toFixed(1)}</div>
                  <div style={{ color: C.textMuted, fontSize: 11, textTransform: 'uppercase' }}>{s} hrs</div>
                </div>
              );
            })}
          </div>
          <TableWrap>
            <thead><tr><Th>Date</Th><Th>Client</Th><Th>Site</Th><Th>Hours</Th><Th>Status</Th></tr></thead>
            <tbody>
              {timesheets.map(ts => (
                <tr key={ts.id}>
                  <Td>{fmtDate(ts.date)}</Td>
                  <Td>{ts.client || '—'}</Td>
                  <Td>{ts.site || '—'}</Td>
                  <Td>{ts.hours}</Td>
                  <Td>{timesheetBadge(ts.status)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </>
      )}

      {modal && (
        <Modal title="Submit Timesheet" onClose={() => { setModal(false); setForm({ client: '', site: '', date: todayISO(), hours: '', notes: '' }); }}>
          <Field label="Date *"><input style={inputStyle} type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} /></Field>
          <Field label="Client"><input style={inputStyle} value={form.client} onChange={e => setForm(f => ({ ...f, client: e.target.value }))} /></Field>
          <Field label="Site"><input style={inputStyle} value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} /></Field>
          <Field label="Hours *"><input style={inputStyle} type="number" step="0.5" min="0" value={form.hours} onChange={e => setForm(f => ({ ...f, hours: e.target.value }))} /></Field>
          <Field label="Notes"><textarea style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></Field>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={() => { setModal(false); setForm({ client: '', site: '', date: todayISO(), hours: '', notes: '' }); }} style={btnSecondary}>Cancel</button>
            <button onClick={handleSubmit} disabled={saving} style={btnPrimary}>{saving ? 'Submitting…' : 'Submit'}</button>
          </div>
        </Modal>
      )}
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
