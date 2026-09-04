import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnDanger, btnSmall } from '../../theme';
import { fmtDate, todayISO } from '../../utils/dates';
import { SendBlastModal } from '../../components/blast/SendBlastModal';
import { useDraft, DraftBanner } from '../../utils/useDraft';
import { Spinner, Badge, Modal, Field, TableWrap, Th, Td, EmptyState, certBadge } from '../../components';
import { EmailHistoryPanel } from '../../components/inbox/EmailHistoryPanel';
import { WorkerCertificateUploads } from '../../components/certificates/WorkerCertificateUploads';
import { JOB_TITLES } from '../../constants/jobTitles';
import { WORKER_TYPES } from '../../constants/scenarios';
import { onboardLink, publicProfileLink, whatsappLink, inviteMessage, normaliseMobileE164AU } from '../../utils/inviteLinks';

const ARCHIVE_REASONS = [
  { value: 'resigned',        label: 'Resigned (left voluntarily)' },
  { value: 'let_go',          label: 'Let go (performance / conduct)' },
  { value: 'end_of_contract', label: 'End of contract' },
  { value: 'medical',         label: 'Medical / injury' },
  { value: 'retired',         label: 'Retired' },
  { value: 'no_show',         label: 'No-show / lost contact' },
  { value: 'other',           label: 'Other' },
];

const REASON_LABEL = Object.fromEntries(ARCHIVE_REASONS.map(r => [r.value, r.label]));

const EMPTY_PAYROLL = {
  tfn: '', bank_account_name: '', bank_bsb: '', bank_account_number: '',
  super_fund_name: '', super_fund_usi: '', super_member_number: '',
  use_default_super: false,
};
const EMPTY_MEDICAL = {
  blood_type: '', allergies: '', conditions: '', medications: '',
  gp_name: '', gp_phone: '', medicare_number: '',
};

function dedupeLicences(s) {
  if (!s) return '';
  const seen = new Set();
  return s.split(',')
    .map(l => l.trim())
    .filter(l => {
      if (!l) return false;
      const k = l.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join(', ');
}

const workerDefaults = {
  name: '', email: '', mobile: '', role: 'worker', job_title: '', licences: '',
  address: '', access_level: 'employee', status: 'available', app_status: 'Active',
  site: '', client: '', worker_type: 'casual',
  pay_rate_a: '', pay_rate_b: '', pay_rate_c: '',
  subcontractor_abn: '', qualified: false,
  is_allocator: false,
  send_invite: true,
};

// Auto-fill B = A * 1.5 and C = A * 2 when the admin hasn't typed those yet.
function autoCalcBC(form) {
  const A = parseFloat(form.pay_rate_a);
  if (!A || isNaN(A)) return form;
  return {
    ...form,
    pay_rate_b: form.pay_rate_b === '' ? (A * 1.5).toFixed(2) : form.pay_rate_b,
    pay_rate_c: form.pay_rate_c === '' ? (A * 2).toFixed(2)   : form.pay_rate_c,
  };
}

export function WorkersPage({ showToast }) {
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterAppStatus, setFilterAppStatus] = useState('');
  const [filterLicence, setFilterLicence] = useState('');
  const [archiveView, setArchiveView] = useState('active'); // 'active' | 'archived' | 'all'
  const [workView, setWorkView] = useState('all');           // 'all' | 'working' | 'free'
  const [busyIds, setBusyIds] = useState(null);              // worker ids on a job today (null = still loading)
  const [blastCrew, setBlastCrew] = useState(null);          // { workers, label } for the bulk-message modal
  const [archiveModal, setArchiveModal] = useState(null); // worker being archived
  const [modal, setModal] = useState(null);
  const [editCerts, setEditCerts] = useState([]);
  const [payroll, setPayroll]     = useState(null);
  const [medical, setMedical]     = useState(null);
  const draftKey = modal === 'add'
    ? 'worker_add'
    : modal && typeof modal === 'object'
      ? `worker_edit_${modal.id}`
      : 'worker_disabled';
  const [form, setForm, draft] = useDraft(draftKey, workerDefaults, { enabled: !!modal });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('workers').select('*').order('created_at', { ascending: false });
    if (error) showToast(error.message, 'error');
    else setWorkers(data || []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  // Who is on a job right now. An allocation counts while today falls inside
  // its date range (a single-day allocation has no end_date), and only if it
  // hasn't been declined or cancelled. Everyone else is available for work —
  // which is the list the office wants to bulk-message.
  useEffect(() => {
    (async () => {
      const today = todayISO();
      const { data, error } = await supabase
        .from('allocations')
        .select('worker_id, start_date, end_date, status')
        .not('status', 'in', '("declined","cancelled")')
        .lte('start_date', today);
      if (error) { setBusyIds(new Set()); return; }
      const ids = new Set(
        (data || [])
          .filter(a => !a.end_date || a.end_date >= today)
          .map(a => a.worker_id)
          .filter(Boolean)
      );
      setBusyIds(ids);
    })();
  }, []);

  const openAdd = () => { setEditCerts([]); setModal('add'); };
  const openEdit = async (w) => {
    setModal(w);
    setForm({
      name: w.name, email: w.email, mobile: w.mobile || '', role: w.role,
      job_title: w.job_title || '', licences: dedupeLicences(w.licences || ''), address: w.address || '',
      access_level: w.access_level || 'employee', status: w.status,
      app_status: w.app_status || 'Active', site: w.site || '', client: w.client || '',
      worker_type: w.worker_type || 'casual',
      pay_rate_a: w.pay_rate_a ?? w.pay_rate_regular ?? '',
      pay_rate_b: w.pay_rate_b ?? w.pay_rate_overtime ?? '',
      pay_rate_c: w.pay_rate_c ?? '',
      subcontractor_abn: w.subcontractor_abn || '',
      qualified: !!w.qualified,
      is_allocator: !!w.is_allocator,
      send_invite: false,
    });
    const { data } = await supabase.from('certifications').select('*').eq('worker_id', w.id).order('expiry', { ascending: true });
    setEditCerts(data || []);

    // RLS gates these to admin/manager roles. Non-admins get empty results
    // silently; save attempts will surface a clear error if they try to write.
    const [pd, md] = await Promise.all([
      supabase.from('worker_payroll_details').select('*').eq('worker_id', w.id).maybeSingle(),
      supabase.from('worker_medical_details').select('*').eq('worker_id', w.id).maybeSingle(),
    ]);
    setPayroll(pd.data || { ...EMPTY_PAYROLL, worker_id: w.id });
    setMedical(md.data || { ...EMPTY_MEDICAL, worker_id: w.id });
  };
  const closeModal = () => {
    draft.clear();
    setModal(null);
    setEditCerts([]);
    setPayroll(null);
    setMedical(null);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.email.trim()) { showToast('Name and email are required.', 'error'); return; }
    setSaving(true);
    const n = v => v === '' ? null : parseFloat(v);
    const A = n(form.pay_rate_a);
    const { send_invite, ...rest } = form;
    const payload = {
      ...rest,
      pay_rate_a: A,
      pay_rate_b: n(form.pay_rate_b) ?? (A != null ? +(A * 1.5).toFixed(2) : null),
      pay_rate_c: n(form.pay_rate_c) ?? (A != null ? +(A * 2).toFixed(2)   : null),
      // Keep legacy columns in sync until they're dropped, so existing payroll
      // calculations relying on them keep working during the transition.
      pay_rate_regular:  A,
      pay_rate_overtime: n(form.pay_rate_b) ?? (A != null ? +(A * 1.5).toFixed(2) : null),
    };

    if (modal === 'add') {
      const { data, error } = await supabase.from('workers').insert([payload]).select().single();
      if (error) { showToast(error.message, 'error'); setSaving(false); return; }

      if (send_invite && data?.profile_token) {
        const link = onboardLink(data.profile_token);
        try { await navigator.clipboard.writeText(link); } catch (e) {}

        // Try to send the email via the Supabase edge function. If RESEND_API_KEY
        // isn't configured yet, the function returns 503 and we fall back to the
        // clipboard message — admin can still paste the link manually.
        try {
          const { data: fnData, error: fnError } = await supabase.functions.invoke('send-invite', {
            body: { worker_id: data.id },
          });
          if (fnError || (fnData && fnData.error)) {
            const msg = fnData?.message || fnError?.message || 'Email not sent';
            showToast(`Worker created. ${msg} Link copied to clipboard.`, 'info');
          } else {
            showToast(`Worker created. Invite emailed to ${data.email}. (Link also copied.)`, 'success');
          }
        } catch (e) {
          showToast(`Worker created. Invite link copied — share it with ${data.name.split(' ')[0]}.`, 'success');
        }
      } else {
        showToast('Worker created successfully', 'success');
      }
      closeModal(); load();
    } else {
      const { error } = await supabase.from('workers').update(payload).eq('id', modal.id);
      if (error) { showToast(error.message, 'error'); setSaving(false); return; }

      // Upsert sensitive details. RLS gates these — non-admin users won't
      // even get the payroll/medical fields rendered in the modal, so this
      // only runs when the admin can see them.
      if (payroll) {
        const blank = v => (v === '' || v == null) ? null : v;
        const { error: pErr } = await supabase.from('worker_payroll_details').upsert({
          worker_id:           modal.id,
          tfn:                 blank(payroll.tfn),
          bank_account_name:   blank(payroll.bank_account_name),
          bank_bsb:            blank(payroll.bank_bsb),
          bank_account_number: blank(payroll.bank_account_number),
          super_fund_name:     blank(payroll.super_fund_name),
          super_fund_usi:      blank(payroll.super_fund_usi),
          super_member_number: blank(payroll.super_member_number),
          use_default_super:   !!payroll.use_default_super,
          updated_at:          new Date().toISOString(),
        }, { onConflict: 'worker_id' });
        if (pErr) { showToast(`Payroll details: ${pErr.message}`, 'error'); setSaving(false); return; }
      }
      if (medical) {
        const blank = v => (v === '' || v == null) ? null : v;
        const { error: mErr } = await supabase.from('worker_medical_details').upsert({
          worker_id:       modal.id,
          blood_type:      blank(medical.blood_type),
          allergies:       blank(medical.allergies),
          conditions:      blank(medical.conditions),
          medications:     blank(medical.medications),
          gp_name:         blank(medical.gp_name),
          gp_phone:        blank(medical.gp_phone),
          medicare_number: blank(medical.medicare_number),
          updated_at:      new Date().toISOString(),
        }, { onConflict: 'worker_id' });
        if (mErr) { showToast(`Medical details: ${mErr.message}`, 'error'); setSaving(false); return; }
      }

      showToast('Worker updated successfully', 'success');
      closeModal();
      load();
    }
    setSaving(false);
  };

  const handleArchive = async ({ reason, notes }) => {
    if (!archiveModal) return;
    const w = archiveModal;
    const archiver = (await supabase.auth.getUser()).data?.user?.email || null;
    const { error } = await supabase.from('workers').update({
      archived_at:     new Date().toISOString(),
      archived_reason: reason,
      archived_notes:  notes || null,
      archived_by:     archiver,
      status:          'unavailable',
      app_status:      'Inactive',
    }).eq('id', w.id);
    if (error) showToast(error.message, 'error');
    else { showToast(`${w.name} archived`, 'success'); setArchiveModal(null); load(); }
  };

  const handleUnarchive = async (w) => {
    if (!window.confirm(`Restore ${w.name} to the active pool?`)) return;
    const { error } = await supabase.from('workers').update({
      archived_at:     null,
      archived_reason: null,
      archived_notes:  null,
      archived_by:     null,
      status:          'available',
      app_status:      'Active',
    }).eq('id', w.id);
    if (error) showToast(error.message, 'error');
    else { showToast(`${w.name} restored`, 'success'); load(); }
  };

  const sendInviteEmail = async (w) => {
    try {
      const { data, error } = await supabase.functions.invoke('send-invite', { body: { worker_id: w.id } });
      if (error || (data && data.error)) {
        const msg = data?.message || error?.message || 'Email not sent';
        const link = onboardLink(w.profile_token);
        try { await navigator.clipboard.writeText(link); } catch (e) {}
        showToast(`${msg} Link copied to clipboard.`, 'info');
      } else {
        showToast(`Invite emailed to ${w.email}`, 'success');
        load();
      }
    } catch (e) {
      showToast(e.message || 'Failed to send invite', 'error');
    }
  };

  const copyShareLink = async (w, kind) => {
    if (!w.profile_token) { showToast('Worker has no profile token yet. Re-save the record.', 'error'); return; }
    const link = kind === 'onboard' ? onboardLink(w.profile_token) : publicProfileLink(w.profile_token);
    try {
      await navigator.clipboard.writeText(link);
      showToast(`${kind === 'onboard' ? 'Onboarding' : 'Profile'} link copied`, 'success');
    } catch (e) { showToast(link, 'info'); }
  };

  // SMS sends for real through Twilio (`send-sms`); WhatsApp still opens a
  // pre-filled chat on the device. The SMS path used to be a `sms:` deep link,
  // which does nothing on a desktop browser except raise a "Pick an
  // application" prompt — same bug as the Pending Workers page (2026-08-04).
  const shareViaSms = async (w) => {
    if (!w.profile_token) { showToast('Worker has no profile token yet. Re-save the record.', 'error'); return; }
    const to = normaliseMobileE164AU(w.mobile);
    if (!to) { showToast(`No mobile number on file for ${w.name || 'this worker'}.`, 'error'); return; }
    const firstName = (w.name || '').split(' ')[0];
    try {
      const { data, error } = await supabase.functions.invoke('send-sms', {
        body: { to, body: inviteMessage({ firstName, link: onboardLink(w.profile_token) }) },
      });
      if (error || data?.error) showToast(`Text failed: ${data?.error || error?.message || 'unknown error'}`, 'error');
      else showToast(`Invite texted to ${to}`, 'success');
    } catch (e) {
      showToast(e.message || 'Failed to send the text', 'error');
    }
  };
  const shareViaWhatsApp = (w) => {
    if (!w.profile_token) { showToast('Worker has no profile token yet. Re-save the record.', 'error'); return; }
    const firstName = (w.name || '').split(' ')[0];
    window.open(whatsappLink({ mobile: w.mobile, body: inviteMessage({ firstName, link: onboardLink(w.profile_token) }) }), '_blank');
  };

  const archivedCount = workers.filter(w => w.archived_at).length;
  const activeCount   = workers.length - archivedCount;

  // Declared as a function (not a const arrow) so it is hoisted: the counts below
// are computed before this point in some portals, and a const would throw a
// temporal-dead-zone ReferenceError and blank the Workers page.
function isWorking(w) { return !!busyIds && busyIds.has(w.id); }

  const filtered = workers.filter(w => {
    if (archiveView === 'active'   && w.archived_at)  return false;
    if (archiveView === 'archived' && !w.archived_at) return false;
    if (workView === 'working' && !isWorking(w)) return false;
    if (workView === 'free'    &&  isWorking(w)) return false;
    const matchSearch = !search || w.name.toLowerCase().includes(search.toLowerCase()) || w.email.toLowerCase().includes(search.toLowerCase()) || (w.licences || '').toLowerCase().includes(search.toLowerCase());
    const matchType = !filterType || (w.worker_type || 'casual') === filterType;
    const matchStatus = !filterStatus || w.status === filterStatus;
    const matchAppStatus = !filterAppStatus || (w.app_status || 'Active') === filterAppStatus;
    const matchLicence = !filterLicence || (w.licences || '').toLowerCase().includes(filterLicence.toLowerCase());
    return matchSearch && matchType && matchStatus && matchAppStatus && matchLicence;
  });

  // Counts are over the live roster only — archived people aren't "available".
  const roster       = workers.filter(w => !w.archived_at);
  const workingCount = roster.filter(isWorking).length;
  const freeCount    = roster.length - workingCount;

  const allLicences = [...new Set(
    workers.flatMap(w => (w.licences || '').split(',').map(l => l.trim()).filter(Boolean).map(l => l.toLowerCase()))
  )].sort();

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {[
          { id: 'active',   label: `Active (${activeCount})` },
          { id: 'archived', label: `Archived (${archivedCount})` },
          { id: 'all',      label: 'All' },
        ].map(v => {
          const on = archiveView === v.id;
          return (
            <button key={v.id} onClick={() => setArchiveView(v.id)} style={{
              padding: '5px 12px',
              background: on ? C.cardHover : 'transparent',
              color: on ? C.text : C.textMuted,
              border: `1px solid ${on ? C.borderStrong : C.border}`,
              borderRadius: 999, cursor: 'pointer',
              fontSize: 12, fontWeight: on ? 600 : 500,
            }}>{v.label}</button>
          );
        })}
      </div>

      {/* Who's on a job vs who's free. The office uses the free list to fill
          tomorrow's jobs and to bulk-message everyone sitting idle. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {[
          { id: 'all',     label: `Everyone (${roster.length})`,        dot: null },
          { id: 'working', label: `On a job now (${workingCount})`,     dot: C.success },
          { id: 'free',    label: `Not currently working (${freeCount})`, dot: C.textDim },
        ].map(v => {
          const on = workView === v.id;
          return (
            <button key={v.id} onClick={() => setWorkView(v.id)} disabled={!busyIds} style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '7px 14px',
              background: on ? C.accentSoft : 'transparent',
              color: on ? C.text : C.textMuted,
              border: `1px solid ${on ? C.accentBorder : C.border}`,
              borderRadius: 999, cursor: busyIds ? 'pointer' : 'wait',
              fontSize: 12.5, fontWeight: on ? 700 : 500,
              opacity: busyIds ? 1 : 0.55,
            }}>
              {v.dot && <span style={{ width: 8, height: 8, borderRadius: '50%', background: v.dot, flexShrink: 0 }} />}
              {v.label}
            </button>
          );
        })}

        {workView === 'free' && freeCount > 0 && (
          <button
            onClick={() => setBlastCrew({
              workers: roster.filter(w => !isWorking(w)).map(w => ({ id: w.id, name: w.name, email: w.email })),
              label: 'Not currently working',
            })}
            style={{ ...btnPrimary, padding: '7px 14px', fontSize: 12.5, marginLeft: 'auto' }}
          >
            📢 Message these {freeCount}
          </button>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flex: 1 }}>
          <input style={{ ...inputStyle, maxWidth: 220 }} placeholder="Search name, email, licence…" value={search} onChange={e => setSearch(e.target.value)} />
          <select style={{ ...inputStyle, maxWidth: 160 }} value={filterType} onChange={e => setFilterType(e.target.value)}>
            <option value="">All Types</option>
            <option value="casual">Casual</option>
            <option value="full-time">Full-Time</option>
            <option value="subcontractor">Subcontractor</option>
          </select>
          <select style={{ ...inputStyle, maxWidth: 160 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="available">Available</option>
            <option value="on_site">On Site</option>
            <option value="job_details_sent">Job Details Sent</option>
            <option value="unavailable">Unavailable</option>
          </select>
          <select style={{ ...inputStyle, maxWidth: 180 }} value={filterAppStatus} onChange={e => setFilterAppStatus(e.target.value)}>
            <option value="">All App Statuses</option>
            <option value="Active">Active</option>
            <option value="Invite Sent">Invite Sent</option>
            <option value="Completing Profile">Completing Profile</option>
            <option value="Profile Incomplete">Profile Incomplete</option>
            <option value="Inactive">Inactive</option>
          </select>
          <select style={{ ...inputStyle, maxWidth: 200 }} value={filterLicence} onChange={e => setFilterLicence(e.target.value)} title="Filter workers by licence/ticket keyword">
            <option value="">🪪 All Licences</option>
            {allLicences.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <button onClick={openAdd} style={btnPrimary}>+ Add Worker</button>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : filtered.length === 0 ? (
        <EmptyState message="No workers found. Add one to get started." />
      ) : (
        <TableWrap>
          <thead><tr><Th>Name</Th><Th>Job Title</Th><Th>Type</Th><Th>Rate A · B · C</Th><Th>Mobile</Th><Th>Licences</Th><Th>Status</Th><Th>App Status</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {filtered.map(w => (
              <tr key={w.id} onClick={() => openEdit(w)} style={{
                cursor: 'pointer',
                opacity: w.archived_at ? 0.55 : 1,
                background: w.archived_at ? 'rgba(100,116,139,0.04)' : undefined,
              }}>
                <Td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <strong>{w.name}</strong>
                    {!w.archived_at && busyIds && (
                      <span
                        title={isWorking(w) ? 'On a job today' : 'Not currently working'}
                        style={{
                          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                          background: isWorking(w) ? C.success : 'transparent',
                          border: isWorking(w) ? 'none' : `1.5px solid ${C.textDim}`,
                        }}
                      />
                    )}
                    {w.qualified && <span title="Qualified" style={{ fontSize: 11 }}>✅</span>}
                    {w.archived_at && (
                      <span style={{
                        fontSize: 9.5, fontFamily: '"DM Mono", monospace', letterSpacing: 1,
                        background: 'rgba(100,116,139,0.18)', color: C.textMuted,
                        padding: '1px 6px', borderRadius: 999, textTransform: 'uppercase', fontWeight: 700,
                      }} title={w.archived_reason ? `${REASON_LABEL[w.archived_reason] || w.archived_reason}${w.archived_notes ? ' — ' + w.archived_notes : ''}` : 'Archived'}>
                        Archived
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: C.textMuted }}>{w.email}</div>
                </Td>
                <Td>{w.job_title || <span style={{ color: C.textMuted }}>—</span>}</Td>
                <Td>
                  <span style={{ fontSize: 11, color: C.textMuted, fontFamily: '"DM Mono", monospace' }}>
                    {w.worker_type || 'casual'}
                  </span>
                </Td>
                <Td>
                  {(w.pay_rate_a ?? w.pay_rate_regular) != null
                    ? <span style={{ fontFamily: '"DM Mono", monospace', fontSize: 12, color: C.success, fontWeight: 600 }}>
                        ${parseFloat(w.pay_rate_a ?? w.pay_rate_regular).toFixed(0)} · ${parseFloat(w.pay_rate_b ?? w.pay_rate_overtime ?? 0).toFixed(0)} · ${parseFloat(w.pay_rate_c ?? 0).toFixed(0)}
                      </span>
                    : <span style={{ color: C.textMuted, fontSize: 12 }}>Not set</span>}
                </Td>
                <Td>{w.mobile || '—'}</Td>
                <Td title={dedupeLicences(w.licences)}>
                  <span style={{ fontSize: 12, color: C.textMuted, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', maxWidth: 240 }}>
                    {dedupeLicences(w.licences) || '—'}
                  </span>
                </Td>
                <Td><Badge label={w.status || 'available'} color={w.status === 'on_site' ? 'green' : w.status === 'job_details_sent' ? 'yellow' : 'blue'} /></Td>
                <Td><Badge label={w.app_status || 'Active'} color={w.app_status === 'Active' ? 'green' : w.app_status === 'Profile Incomplete' ? 'yellow' : 'gray'} /></Td>
                <Td onClick={e => e.stopPropagation()}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button onClick={() => openEdit(w)} style={btnSmall}>Edit</button>
                    {w.qualified && !w.archived_at && (
                      {/* Client-facing profile link parked 2026-08-25 (team decision: the info it
                          shares — casual, availability — is not for clients). The /p/<token> route
                          and copyShareLink('profile') stay intact for when it comes back. */}
                    )}
                    {w.archived_at
                      ? <button onClick={() => handleUnarchive(w)} style={{ ...btnSmall, background: 'rgba(34,197,94,0.12)', color: C.success, border: 'none' }}>↺ Restore</button>
                      : <button onClick={() => setArchiveModal(w)} style={btnDanger}>Archive</button>}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      {modal && (
        <Modal title={modal === 'add' ? 'Add Worker' : 'Edit Worker'} onClose={closeModal} width={620}>
          {modal !== 'add' && modal.archived_at && (
            <div style={{
              background: 'rgba(100,116,139,0.10)',
              border: `1px solid ${C.border}`,
              borderRadius: 8, padding: '10px 14px', marginBottom: 14,
              fontSize: 12.5,
            }}>
              <div style={{
                fontSize: 10, fontFamily: '"DM Mono", monospace', letterSpacing: 1.5,
                textTransform: 'uppercase', color: C.textMuted, fontWeight: 700, marginBottom: 4,
              }}>📦 Archived</div>
              <div style={{ color: C.text }}>
                <strong>{REASON_LABEL[modal.archived_reason] || modal.archived_reason || 'No reason recorded'}</strong>
                {' · '}
                <span style={{ color: C.textMuted }}>{fmtDate(modal.archived_at)}</span>
                {modal.archived_by && <span style={{ color: C.textMuted }}> · by {modal.archived_by}</span>}
              </div>
              {modal.archived_notes && (
                <div style={{ marginTop: 6, color: C.textMuted, fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                  {modal.archived_notes}
                </div>
              )}
              <div style={{ marginTop: 8 }}>
                <button onClick={() => { closeModal(); handleUnarchive(modal); }} style={{ ...btnSmall, background: 'rgba(34,197,94,0.12)', color: C.success, border: 'none' }}>
                  ↺ Restore to active pool
                </button>
              </div>
            </div>
          )}
          <DraftBanner
            visible={draft.draftRestored}
            onDiscard={() => { draft.discardDraft(); setForm(workerDefaults); }}
            onDismiss={draft.dismissBanner}
            label={modal === 'add' ? 'Unsaved draft restored.' : 'Unsaved edits to this worker were restored.'}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <Field label="Full Name *"><input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></Field>
            <Field label="Email *"><input style={inputStyle} type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></Field>
            <Field label="Mobile"><input style={inputStyle} value={form.mobile} onChange={e => setForm(f => ({ ...f, mobile: e.target.value }))} /></Field>
            <Field label="Job Title">
              <>
                <input style={inputStyle} list="job-titles-list" value={form.job_title} onChange={e => setForm(f => ({ ...f, job_title: e.target.value }))} placeholder="Type or select a role…" />
                <datalist id="job-titles-list">
                  {JOB_TITLES.map(t => <option key={t} value={t} />)}
                </datalist>
              </>
            </Field>
            <Field
              label="Quick Licences"
              hint={modal === 'add'
                ? 'Free-text shortcut for fast capture. After save, add proper expiry-tracked tickets in the 🪪 Certifications section.'
                : 'Free-text only — for tickets with expiry dates, use the 🪪 Certifications section below or the Licence Agent page.'}
            >
              <input style={inputStyle} value={form.licences} onChange={e => setForm(f => ({ ...f, licences: e.target.value }))} placeholder="e.g. EWP, VOC Excavator, RIW…" />
            </Field>
            <Field label="Address"><input style={inputStyle} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></Field>
            <Field label="Portal Access">
              <select style={inputStyle} value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                <option value="worker">Worker</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
            <Field label="Access Level">
              <select style={inputStyle} value={form.access_level} onChange={e => setForm(f => ({ ...f, access_level: e.target.value }))}>
                <option value="employee">Employee</option>
                <option value="manager">Manager</option>
              </select>
            </Field>
            <Field label="Worker Type">
              <select style={inputStyle} value={form.worker_type} onChange={e => setForm(f => ({ ...f, worker_type: e.target.value }))}>
                {WORKER_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            <div /> {/* spacer */}

            <div style={{ gridColumn: '1 / -1', marginTop: 2, marginBottom: 2 }}>
              <label style={{
                display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
                background: form.is_allocator ? 'rgba(249,115,22,0.08)' : 'transparent',
                border: `1px solid ${form.is_allocator ? C.accent : C.border}`,
                borderRadius: 8, padding: '11px 13px', transition: 'all .15s',
              }}>
                <input
                  type="checkbox"
                  checked={!!form.is_allocator}
                  onChange={e => setForm(f => ({ ...f, is_allocator: e.target.checked }))}
                  style={{ marginTop: 2, accentColor: C.accent, width: 16, height: 16, flexShrink: 0 }}
                />
                <span>
                  <span style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>📣 Allocator — gets allocation alerts</span>
                  <span style={{ display: 'block', color: C.textMuted, fontSize: 11.5, marginTop: 3, lineHeight: 1.5 }}>
                    Texted and emailed whenever a worker is allocated, accepts or declines.
                    Tick as many people as you want. Everyone else still sees it in the
                    notification bell — they just don't get buzzed. If nobody is ticked,
                    alerts go to the team inbox only.
                  </span>
                </span>
              </label>
            </div>

            <div style={{ gridColumn: '1 / -1', marginTop: 6, marginBottom: 6 }}>
              <div style={{
                background: 'rgba(249,115,22,0.06)', border: `1px solid ${C.border}`,
                borderRadius: 8, padding: '12px 14px',
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.accent, letterSpacing: 1, marginBottom: 8 }}>
                  💰 PAY RATE BANDS ($/hr)
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  <Field label="A — Normal (Mon–Fri ≤8h)">
                    <input style={inputStyle} type="number" step="0.01" min="0"
                      value={form.pay_rate_a}
                      onChange={e => setForm(f => ({ ...f, pay_rate_a: e.target.value }))}
                      onBlur={() => setForm(f => autoCalcBC(f))}
                      placeholder="e.g. 35.00" />
                  </Field>
                  <Field label="B — OT 1.5× (night/Sat day)">
                    <input style={inputStyle} type="number" step="0.01" min="0"
                      value={form.pay_rate_b}
                      onChange={e => setForm(f => ({ ...f, pay_rate_b: e.target.value }))}
                      placeholder="auto from A × 1.5" />
                  </Field>
                  <Field label="C — OT 2× (Sun/PH/Sat >8h)">
                    <input style={inputStyle} type="number" step="0.01" min="0"
                      value={form.pay_rate_c}
                      onChange={e => setForm(f => ({ ...f, pay_rate_c: e.target.value }))}
                      placeholder="auto from A × 2" />
                  </Field>
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
                  Leave B and C blank to auto-fill from A (×1.5 and ×2). Override per worker if their rates differ.
                </div>
              </div>
            </div>

            {form.worker_type === 'subcontractor' && (
              <Field label="Subcontractor ABN">
                <input style={inputStyle} value={form.subcontractor_abn} onChange={e => setForm(f => ({ ...f, subcontractor_abn: e.target.value }))} placeholder="e.g. 12 345 678 901" />
              </Field>
            )}
            <Field label="Work Status">
              <select style={inputStyle} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                <option value="available">Available</option>
                <option value="on_site">On Site</option>
                <option value="job_details_sent">Job Details Sent</option>
                <option value="unavailable">Unavailable</option>
              </select>
            </Field>
            <Field label="App Status">
              <select style={inputStyle} value={form.app_status} onChange={e => setForm(f => ({ ...f, app_status: e.target.value }))}>
                <option value="Active">Active</option>
                <option value="Invite Sent">Invite Sent</option>
                <option value="Completing Profile">Completing Profile</option>
                <option value="Profile Incomplete">Profile Incomplete</option>
                <option value="Inactive">Inactive</option>
              </select>
            </Field>
            <Field label="Current Site"><input style={inputStyle} value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} /></Field>
            <Field label="Current Client"><input style={inputStyle} value={form.client} onChange={e => setForm(f => ({ ...f, client: e.target.value }))} /></Field>

            <div style={{ gridColumn: '1 / -1', marginTop: 6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.text, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!form.qualified} onChange={e => setForm(f => ({ ...f, qualified: e.target.checked }))} />
                <span>✅ Qualified — enables shareable client-facing profile link</span>
              </label>
            </div>
          </div>

          {modal === 'add' && (
            <div style={{
              marginTop: 14, background: 'rgba(19,181,234,0.08)', border: '1px solid rgba(19,181,234,0.25)',
              borderRadius: 8, padding: '10px 14px',
            }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.text, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!form.send_invite} onChange={e => setForm(f => ({ ...f, send_invite: e.target.checked }))} />
                <span>📧 Send onboarding invite — copies a magic link the worker can use to fill out their own profile (mobile, address, licences).</span>
              </label>
            </div>
          )}

          {modal !== 'add' && modal?.profile_token && (
            <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => sendInviteEmail(modal)} style={btnSmall} type="button">
                ✉️ {modal.profile_invite_sent_at ? 'Resend' : 'Send'} Invite Email
              </button>
              <button onClick={() => shareViaWhatsApp(modal)} style={btnSmall} type="button" title={modal.mobile ? `WhatsApp ${modal.mobile}` : 'Open WhatsApp'}>
                💬 WhatsApp Invite
              </button>
              <button onClick={() => shareViaSms(modal)} style={btnSmall} type="button" title={modal.mobile ? `SMS ${modal.mobile}` : 'Open SMS'}>
                📨 SMS Invite
              </button>
              <button onClick={() => copyShareLink(modal, 'onboard')} style={btnSmall} type="button">
                📋 Copy Onboarding Link
              </button>
{/* profile share button parked 2026-08-25 — see note in the row actions */}
            </div>
          )}

          {modal !== 'add' && modal.photo_url && (
            <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 14 }}>
              <img
                src={modal.photo_url}
                alt={modal.name}
                style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover', border: `1px solid ${C.border}` }}
              />
              <div style={{ fontSize: 11.5, color: C.textDim }}>Profile photo on file (set by worker during onboarding).</div>
            </div>
          )}

          {modal !== 'add' && (
            <WorkerTicketsSection
              workerId={modal.id}
              certs={editCerts}
              setCerts={setEditCerts}
              showToast={showToast}
            />
          )}

          {modal !== 'add' && (
            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, margin: '0 0 8px' }}>
                🪪 Worker-uploaded certificates
              </div>
              <WorkerCertificateUploads workerId={modal.id} showToast={showToast} canEdit={false} />
            </div>
          )}

          {modal !== 'add' && payroll && (
            <SensitivePanel
              title="💵 Payroll Details"
              subtitle="Tax, bank, super. Only visible to admin / manager roles."
              fields={[
                ['Tax File Number', 'tfn', { mask: true }],
                ['Account holder name', 'bank_account_name'],
                ['BSB', 'bank_bsb'],
                ['Account number', 'bank_account_number', { mask: true }],
                ['Super fund name', 'super_fund_name'],
                ['Fund USI', 'super_fund_usi'],
                ['Member number', 'super_member_number'],
              ]}
              extraChildren={(
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.textMuted, marginTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={!!payroll.use_default_super}
                    onChange={e => setPayroll(p => ({ ...p, use_default_super: e.target.checked }))}
                  />
                  Uses CBD default super fund
                </label>
              )}
              data={payroll}
              setData={setPayroll}
            />
          )}

          {modal !== 'add' && medical && (
            <SensitivePanel
              title="⚕️ Medical & GP"
              subtitle="For first-aid responders on site. Same admin-only access as payroll."
              fields={[
                ['Blood type', 'blood_type'],
                ['Allergies', 'allergies', { multiline: true }],
                ['Conditions', 'conditions', { multiline: true }],
                ['Medications', 'medications', { multiline: true }],
                ['GP name', 'gp_name'],
                ['GP phone', 'gp_phone'],
                ['Medicare number', 'medicare_number', { mask: true }],
              ]}
              data={medical}
              setData={setMedical}
            />
          )}

          {modal !== 'add' && (
            <div style={{ marginTop: 14 }}>
              <EmailHistoryPanel
                workerId={modal.id}
                onOpenInbox={(threadId) => {
                  if (threadId) window.sessionStorage.setItem('inbox_focus_thread', threadId);
                  window.dispatchEvent(new CustomEvent('cbd:navigate', { detail: { page: 'inbox' } }));
                }}
              />
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
            <button onClick={closeModal} style={btnSecondary}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}

      {archiveModal && (
        <ArchiveWorkerModal
          worker={archiveModal}
          onClose={() => setArchiveModal(null)}
          onConfirm={handleArchive}
        />
      )}

      {blastCrew && (
        <SendBlastModal
          presetWorkers={blastCrew.workers}
          presetLabel={blastCrew.label}
          onClose={() => setBlastCrew(null)}
          showToast={showToast}
        />
      )}
    </div>
  );
}

function ArchiveWorkerModal({ worker, onClose, onConfirm }) {
  const [reason, setReason] = useState('resigned');
  const [notes,  setNotes]  = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    await onConfirm({ reason, notes });
    setSaving(false);
  };

  return (
    <Modal title={`Archive ${worker.name}`} onClose={onClose} width={500}>
      <p style={{ color: C.textMuted, fontSize: 13, margin: '0 0 14px 0', lineHeight: 1.55 }}>
        Their profile stays in the system (allocations, timesheets and payroll
        history are preserved), but they're hidden from new allocations,
        bulk messages and the active pool. You can restore them later if
        they come back.
      </p>
      <Field label="Why are they leaving? *">
        <select style={inputStyle} value={reason} onChange={e => setReason(e.target.value)}>
          {ARCHIVE_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </Field>
      <Field label="Notes (visible to other admins)" hint="Capture what the next person needs to know: capability, what they're qualified for, any context for if they come back, etc.">
        <textarea
          style={{ ...inputStyle, minHeight: 110, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.55 }}
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder={`e.g. Excellent operator on Sydney Water roads. Holds EWP + RIW. Left to take a permanent role with the principal. Happy to come back for casual work — call first.`}
        />
      </Field>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
        <button onClick={onClose} style={btnSecondary} disabled={saving}>Cancel</button>
        <button onClick={submit} style={btnDanger} disabled={saving}>
          {saving ? 'Archiving…' : 'Archive Worker'}
        </button>
      </div>
    </Modal>
  );
}

// ── Inline ticket management for the Worker edit modal ─────────────────────

// Collapsible admin-only panel for sensitive worker fields (payroll / medical).
// Shows masked values by default with a "Reveal" toggle so the data isn't
// shoulder-surfable when someone has the modal open in the office.
function SensitivePanel({ title, subtitle, fields, data, setData, extraChildren }) {
  const [open,    setOpen]    = useState(false);
  const [reveal,  setReveal]  = useState(false);

  const maskValue = (v) => {
    if (!v) return '';
    const s = String(v);
    if (s.length <= 4) return '••' + s.slice(-2);
    return '•••• ' + s.slice(-3);
  };

  return (
    <div style={{
      marginTop: 14,
      background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
      overflow: 'hidden',
    }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px',
          background: open ? C.card : 'transparent',
          border: 'none', borderBottom: open ? `1px solid ${C.border}` : 'none',
          cursor: 'pointer', textAlign: 'left',
          color: C.text,
        }}
      >
        <span style={{ fontSize: 12, color: C.textDim, fontFamily: '"DM Mono", monospace' }}>{open ? '▾' : '▸'}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>{title}</div>
          <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 1 }}>{subtitle}</div>
        </div>
        {open && (
          <span
            onClick={e => { e.stopPropagation(); setReveal(r => !r); }}
            style={{
              fontSize: 11, color: C.accent, fontFamily: '"DM Mono", monospace',
              padding: '3px 8px', border: `1px solid ${C.border}`, borderRadius: 999,
            }}>
            {reveal ? '🙈 Mask' : '👁 Reveal'}
          </span>
        )}
      </button>
      {open && (
        <div style={{ padding: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px' }}>
            {fields.map(([label, key, opts]) => {
              const multiline = opts?.multiline;
              const mask      = opts?.mask;
              const display   = (mask && !reveal) ? maskValue(data[key]) : (data[key] || '');
              return (
                <div key={key} style={{ gridColumn: multiline ? '1 / -1' : 'auto' }}>
                  <Field label={label}>
                    {multiline
                      ? <textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }}
                          value={data[key] || ''}
                          onChange={e => setData(d => ({ ...d, [key]: e.target.value }))} />
                      : <input style={inputStyle}
                          value={display}
                          onChange={e => setData(d => ({ ...d, [key]: e.target.value }))}
                          placeholder={mask && !reveal && data[key] ? '' : ''}
                          onFocus={() => { if (mask) setReveal(true); }} />}
                  </Field>
                </div>
              );
            })}
          </div>
          {extraChildren}
        </div>
      )}
    </div>
  );
}

function WorkerTicketsSection({ workerId, certs, setCerts, showToast }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ cert_name: '', issuer: '', expiry: '' });
  const [saving, setSaving] = useState(false);

  const resetForm = () => setForm({ cert_name: '', issuer: '', expiry: '' });

  const startAdd = () => { resetForm(); setEditingId(null); setAdding(true); };
  const startEdit = (c) => {
    setForm({ cert_name: c.cert_name || '', issuer: c.issuer || '', expiry: c.expiry || '' });
    setEditingId(c.id);
    setAdding(true);
  };
  const cancel = () => { setAdding(false); setEditingId(null); resetForm(); };

  const save = async () => {
    if (!form.cert_name.trim()) { showToast('Ticket name is required.', 'error'); return; }
    setSaving(true);
    const payload = {
      worker_id: workerId,
      cert_name: form.cert_name.trim(),
      issuer:    form.issuer.trim() || null,
      expiry:    form.expiry || null,
    };
    if (editingId) {
      const { data, error } = await supabase.from('certifications').update(payload).eq('id', editingId).select().single();
      if (error) { showToast(error.message, 'error'); setSaving(false); return; }
      setCerts(prev => prev.map(c => c.id === editingId ? data : c).sort((a, b) => (a.expiry || '9999') < (b.expiry || '9999') ? -1 : 1));
      showToast('Ticket updated', 'success');
    } else {
      const { data, error } = await supabase.from('certifications').insert([payload]).select().single();
      if (error) { showToast(error.message, 'error'); setSaving(false); return; }
      setCerts(prev => [...prev, data].sort((a, b) => (a.expiry || '9999') < (b.expiry || '9999') ? -1 : 1));
      showToast('Ticket added', 'success');
    }
    cancel();
    setSaving(false);
  };

  const remove = async (c) => {
    if (!window.confirm(`Delete ticket "${c.cert_name}"?`)) return;
    const { error } = await supabase.from('certifications').delete().eq('id', c.id);
    if (error) { showToast(error.message, 'error'); return; }
    setCerts(prev => prev.filter(x => x.id !== c.id));
    showToast('Ticket deleted', 'success');
  };

  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.text, letterSpacing: 1 }}>🪪 TICKETS / CERTIFICATIONS</div>
        {!adding && (
          <button onClick={startAdd} type="button" style={{ ...btnSmall, background: 'rgba(249,115,22,0.12)', color: C.accent, border: 'none' }}>
            + Add Ticket
          </button>
        )}
      </div>

      {certs.length === 0 && !adding ? (
        <div style={{ fontSize: 12, color: C.textMuted, padding: '6px 0' }}>No tickets recorded for this worker yet. Click <strong>+ Add Ticket</strong> to add one.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 220, overflowY: 'auto' }}>
          {certs.map(c => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: C.bg, borderRadius: 7, padding: '7px 10px', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{c.cert_name}</div>
                {c.issuer && <div style={{ fontSize: 11, color: C.textMuted }}>{c.issuer}</div>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: C.textMuted, fontFamily: '"DM Mono", monospace' }}>
                  {c.expiry ? fmtDate(c.expiry) : 'No expiry'}
                </span>
                {certBadge(c.expiry)}
                <button onClick={() => startEdit(c)} type="button" style={{ ...btnSmall, padding: '3px 8px', fontSize: 11 }}>Edit</button>
                <button onClick={() => remove(c)} type="button" style={{ ...btnDanger, padding: '3px 8px', fontSize: 11 }}>×</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <div style={{ marginTop: 10, background: C.bg, border: `1px solid ${C.accent}`, borderRadius: 8, padding: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>
            {editingId ? 'Edit ticket' : 'New ticket'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
            <Field label="Ticket / Cert Name *">
              <input style={inputStyle} value={form.cert_name} onChange={e => setForm(f => ({ ...f, cert_name: e.target.value }))} placeholder="e.g. EWP Boom Lift" />
            </Field>
            <Field label="Issuer">
              <input style={inputStyle} value={form.issuer} onChange={e => setForm(f => ({ ...f, issuer: e.target.value }))} placeholder="e.g. WorkSafe" />
            </Field>
            <Field label="Expiry">
              <input style={inputStyle} type="date" value={form.expiry} onChange={e => setForm(f => ({ ...f, expiry: e.target.value }))} />
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={cancel} type="button" style={btnSecondary}>Cancel</button>
            <button onClick={save} type="button" disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : editingId ? 'Update' : 'Add Ticket'}</button>
          </div>
        </div>
      )}

      <div style={{ fontSize: 10.5, color: C.textDim, marginTop: 8 }}>
        Tip: workers can also self-add their tickets from the onboarding link. Photo uploads coming soon — for now manage them here or on the <strong>Licence Agent</strong> page.
      </div>
    </div>
  );
}
