// Sales partners — office page (2026-11-09).
// Tabs: Partners · Referrals · Commission · Reports.
// Office users (isOfficeUser) manage partners and referral statuses. Money
// users (isMoneyUser = canSeeMoney) also see rates, bank details, placements
// and commission lines. RLS enforces the same line server-side.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary, btnSecondary, btnSmall, btnDanger } from '../../theme';
import { Modal, Field, Spinner, EmptyState, Badge, TableWrap, Th, Td, DateField } from '../../components';
import { StatCard, StatGrid, Card, SectionTitle, KV, ReferralStatusBadge, CommissionStatusBadge, ReferralTimeline, ReferralFacts, money } from '../../components/partner/partnerShared';
import { REFERRAL_STATUSES, REFERRAL_TYPES, SOURCE_OPTIONS, recompute, partnerReport, WON_STATUSES, EARNING_STATUSES } from '../../utils/commission';
import { autoFromPortal } from '../../utils/partnerAuto';
import { canSeeMoney } from '../../utils/access';
import { downloadCSV } from '../../utils/csv';
import { fmtDate, fmtDateTime } from '../../utils/dates';
import { logActivity } from '../../utils/activity';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const notifyPartner = (body) => supabase.functions.invoke('notify-partner', { body }).catch(() => ({ error: { message: 'notify failed' } }));

export function SalesPartnersPage({ showToast, currentWorker, isMobile }) {
  const isMoneyUser = canSeeMoney(currentWorker);
  const [tab, setTab] = useState('partners');
  const [d, setD] = useState({ partners: [], referrals: [], events: [], placements: [], lines: [], loading: true });
  const [edit, setEdit] = useState(null);          // partner modal: {} new | partner row
  const [openRef, setOpenRef] = useState(null);    // referral id
  const [bankFor, setBankFor] = useState(null);    // partner row

  const reload = useCallback(async () => {
    const [p, r, ev, pl, ln] = await Promise.all([
      supabase.from('sales_partners').select('*').order('created_at', { ascending: false }),
      supabase.from('partner_referrals').select('*').order('created_at', { ascending: false }),
      supabase.from('partner_referral_events').select('*').order('created_at', { ascending: true }),
      isMoneyUser ? supabase.from('partner_placements').select('*').order('period_start', { ascending: false }) : Promise.resolve({ data: [] }),
      isMoneyUser ? supabase.from('partner_commission_lines').select('*').order('created_at', { ascending: false }) : Promise.resolve({ data: [] }),
    ]);
    const err = [p, r, ev, pl, ln].find(x => x?.error)?.error;
    if (err) showToast(`Could not load: ${err.message}`, 'error');
    setD({ partners: p.data || [], referrals: r.data || [], events: ev.data || [], placements: pl.data || [], lines: ln.data || [], loading: false });
  }, [isMoneyUser, showToast]);
  useEffect(() => { reload(); }, [reload]);

  const tabs = [
    { id: 'partners', label: `🤝 Partners (${d.partners.filter(p => p.status !== 'archived').length})` },
    { id: 'referrals', label: `📋 Referrals (${d.referrals.filter(r => !['completed', 'declined', 'duplicate'].includes(r.status) && !r.archived_at).length})` },
    ...(isMoneyUser ? [{ id: 'commission', label: `💰 Commission (${d.lines.filter(l => l.status === 'pending').length})` }] : []),
    { id: 'reports', label: '📁 Reports' },
  ];

  return (
    <div data-area="sales partners page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: isMobile ? 18 : 22, fontWeight: 700, color: C.text, letterSpacing: -0.3 }}>Sales partners</h2>
        <button style={btnPrimary} onClick={() => setEdit({})}>+ Add partner</button>
      </div>
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 14, overflowX: 'auto' }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '10px 12px', color: tab === t.id ? C.accent : C.textMuted, fontWeight: tab === t.id ? 700 : 500, fontSize: 13, borderBottom: `2px solid ${tab === t.id ? C.accent : 'transparent'}`, whiteSpace: 'nowrap' }}>{t.label}</button>
        ))}
      </div>
      {d.loading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={32} /></div> : (
        <>
          {tab === 'partners'   && <Partners d={d} isMoneyUser={isMoneyUser} isMobile={isMobile} onEdit={setEdit} onBank={setBankFor} reload={reload} showToast={showToast} currentWorker={currentWorker} />}
          {tab === 'referrals'  && <Referrals d={d} isMobile={isMobile} open={setOpenRef} />}
          {tab === 'commission' && isMoneyUser && <CommissionAdmin d={d} isMobile={isMobile} reload={reload} showToast={showToast} currentWorker={currentWorker} />}
          {tab === 'reports'    && <Reports d={d} isMoneyUser={isMoneyUser} isMobile={isMobile} />}
        </>
      )}
      {edit && <PartnerModal partner={edit.id ? edit : null} isMoneyUser={isMoneyUser} onClose={() => setEdit(null)} showToast={showToast} reload={reload} currentWorker={currentWorker} />}
      {bankFor && isMoneyUser && <BankModal partner={bankFor} onClose={() => setBankFor(null)} />}
      {openRef && <ReferralAdminModal id={openRef} d={d} isMoneyUser={isMoneyUser} isMobile={isMobile} onClose={() => setOpenRef(null)} reload={reload} showToast={showToast} currentWorker={currentWorker} />}
    </div>
  );
}

// ── Partners ─────────────────────────────────────────────────────────────────
function Partners({ d, isMoneyUser, isMobile, onEdit, onBank, reload, showToast, currentWorker }) {
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const list = d.partners.filter(p => showArchived ? true : p.status !== 'archived');

  async function invite(p) {
    setBusyId(p.id);
    const { data, error } = await supabase.functions.invoke('partner-invite', { body: { partner_id: p.id } });
    setBusyId(null);
    if (error || !data?.ok) { showToast(`Invite failed: ${data?.detail || data?.error || error?.message || 'unknown'}`, 'error'); reload(); return; }
    showToast(`Invite emailed to ${data.email} (${data.via}).`, 'success'); reload();
  }
  async function archive(p) {
    const reason = window.prompt(`Archive ${p.name}? Their referrals and commission history stay. Reason:`, '');
    if (reason === null) return;
    const { error } = await supabase.from('sales_partners').update({ status: 'archived', archived_at: new Date().toISOString(), archived_reason: reason || null }).eq('id', p.id);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: 'archived', object_type: 'sales_partner', object_id: p.id, after: { name: p.name, reason } });
    showToast('Partner archived.', 'success'); reload();
  }
  async function restore(p) {
    const { error } = await supabase.from('sales_partners').update({ status: p.auth_user_id ? 'active' : 'invited', archived_at: null, archived_reason: null }).eq('id', p.id);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: 'restored', object_type: 'sales_partner', object_id: p.id, after: { name: p.name } });
    reload();
  }
  const stBadge = (s) => <Badge label={s} color={s === 'active' ? 'green' : s === 'invited' ? 'yellow' : 'gray'} />;
  const refCount = (p) => d.referrals.filter(r => r.partner_id === p.id).length;

  return (
    <div data-area="partners list">
      <label style={{ fontSize: 12, color: C.textMuted, display: 'inline-flex', gap: 6, alignItems: 'center', marginBottom: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Show archived
      </label>
      {list.length === 0 ? <EmptyState icon="🤝" message="No sales partners yet. Add one, then send the invite." /> : isMobile ? (
        <div style={{ display: 'grid', gap: 8 }}>
          {list.map(p => (
            <Card key={p.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: C.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.company || '—'} · {p.email}</div>
                  <div style={{ fontSize: 11, color: C.textDim, fontFamily: MONO, marginTop: 2 }}>{refCount(p)} referrals{p.invite_sent_at ? ` · invited ${fmtDate(p.invite_sent_at)}` : ''}</div>
                </div>
                {stBadge(p.status)}
              </div>
              <PartnerActions p={p} busy={busyId === p.id} isMoneyUser={isMoneyUser} onEdit={onEdit} onBank={onBank} invite={invite} archive={archive} restore={restore} />
            </Card>
          ))}
        </div>
      ) : (
        <TableWrap>
          <thead><tr><Th>Partner</Th><Th>Company</Th><Th>Email</Th><Th>Status</Th><Th align="right">Referrals</Th>{isMoneyUser && <Th>Rates</Th>}<Th>Actions</Th></tr></thead>
          <tbody>
            {list.map(p => (
              <tr key={p.id}>
                <Td><strong>{p.name}</strong>{p.phone ? <div style={{ fontSize: 11, color: C.textDim, fontFamily: MONO }}>{p.phone}</div> : null}</Td>
                <Td>{p.company || '—'}{p.abn ? <div style={{ fontSize: 11, color: C.textDim, fontFamily: MONO }}>ABN {p.abn}</div> : null}</Td>
                <Td style={{ fontSize: 12 }}>{p.email}{p.invite_sent_at ? <div style={{ fontSize: 11, color: C.textDim }}>invited {fmtDate(p.invite_sent_at)}</div> : null}</Td>
                <Td>{stBadge(p.status)}</Td>
                <Td align="right" style={{ fontFamily: MONO }}>{refCount(p)}</Td>
                {isMoneyUser && <Td style={{ fontFamily: MONO, fontSize: 12 }}>{money(p.first_placement_bonus)} · {Number(p.residual_pct_y1)}% / {Number(p.residual_pct_y2)}%</Td>}
                <Td><PartnerActions p={p} busy={busyId === p.id} isMoneyUser={isMoneyUser} onEdit={onEdit} onBank={onBank} invite={invite} archive={archive} restore={restore} /></Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
function PartnerActions({ p, busy, isMoneyUser, onEdit, onBank, invite, archive, restore }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
      {p.status !== 'archived' && <button style={btnSmall} onClick={() => onEdit(p)}>Edit</button>}
      {p.status !== 'archived' && <button style={btnSmall} disabled={busy} onClick={() => invite(p)} data-testid={`invite-${p.id}`}>{busy ? 'Sending…' : p.invite_sent_at ? 'Resend invite' : 'Send invite'}</button>}
      {isMoneyUser && <button style={btnSmall} onClick={() => onBank(p)}>Bank</button>}
      {p.status !== 'archived' ? <button style={btnDanger} onClick={() => archive(p)} data-testid={`archive-${p.id}`}>Archive</button> : <button style={btnSmall} onClick={() => restore(p)}>Restore</button>}
    </div>
  );
}

function PartnerModal({ partner, isMoneyUser, onClose, showToast, reload, currentWorker }) {
  const [f, setF] = useState({ name: partner?.name || '', email: partner?.email || '', company: partner?.company || '', phone: partner?.phone || '', abn: partner?.abn || '',
    first_placement_bonus: partner?.first_placement_bonus ?? 1000, residual_pct_y1: partner?.residual_pct_y1 ?? 10, residual_pct_y2: partner?.residual_pct_y2 ?? 5, sendInvite: !partner });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  async function save(e) {
    e.preventDefault();
    if (!f.name.trim()) { showToast('Name is required.', 'error'); return; }
    if (!EMAIL_RE.test(f.email.trim())) { showToast('A valid email is required.', 'error'); return; }
    setBusy(true);
    const row = { name: f.name.trim(), email: f.email.trim().toLowerCase(), company: f.company.trim() || null, phone: f.phone.trim() || null, abn: f.abn.replace(/\s/g, '') || null };
    if (isMoneyUser) Object.assign(row, { first_placement_bonus: Number(f.first_placement_bonus) || 0, residual_pct_y1: Number(f.residual_pct_y1) || 0, residual_pct_y2: Number(f.residual_pct_y2) || 0 });
    let id = partner?.id;
    if (partner) {
      const { error } = await supabase.from('sales_partners').update(row).eq('id', partner.id);
      if (error) { setBusy(false); showToast(error.message, 'error'); return; }
      logActivity({ verb: 'updated', object_type: 'sales_partner', object_id: partner.id, before: { name: partner.name }, after: { name: row.name } });
    } else {
      const { data, error } = await supabase.from('sales_partners').insert([{ ...row, status: 'invited', created_by: currentWorker?.id || null }]).select('id').single();
      if (error) { setBusy(false); showToast(/duplicate|unique/i.test(error.message) ? 'A partner with that email already exists.' : error.message, 'error'); return; }
      id = data.id;
      logActivity({ verb: 'created', object_type: 'sales_partner', object_id: id, after: { name: row.name, email: row.email } });
      showToast(f.sendInvite ? 'Partner saved — sending the invite email…' : 'Partner saved.', 'success');
      if (f.sendInvite) {
        // The e-mail hop can take a few seconds; do not hold the modal open for it.
        supabase.functions.invoke('partner-invite', { body: { partner_id: id } }).then(({ data: inv, error: invErr }) => {
          if (invErr || !inv?.ok) showToast(`Invite email failed: ${inv?.detail || inv?.error || invErr?.message}. Use "Send invite" to retry.`, 'error');
          else showToast(`Invite emailed to ${inv.email} (${inv.via}).`, 'success');
          reload();
        });
      }
    }
    setBusy(false); reload(); onClose();
  }
  return (
    <Modal title={partner ? 'Edit partner' : 'Add sales partner'} onClose={onClose} width={520}>
      <form onSubmit={save} data-area="partner form">
        <Field label="Name *"><input style={inputStyle} value={f.name} onChange={e => set('name', e.target.value)} autoFocus /></Field>
        <Field label="Email (login) *" hint={partner ? 'Changing the email changes who can sign in.' : undefined}><input style={inputStyle} value={f.email} onChange={e => set('email', e.target.value)} inputMode="email" /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
          <Field label="Company"><input style={inputStyle} value={f.company} onChange={e => set('company', e.target.value)} /></Field>
          <Field label="Phone"><input style={inputStyle} value={f.phone} onChange={e => set('phone', e.target.value)} inputMode="tel" /></Field>
        </div>
        <Field label="ABN"><input style={inputStyle} value={f.abn} onChange={e => set('abn', e.target.value)} inputMode="numeric" /></Field>
        {isMoneyUser && (
          <>
            <SectionTitle>Commission rates</SectionTitle>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
              <Field label="First placement bonus $"><input style={inputStyle} type="number" step="50" min="0" value={f.first_placement_bonus} onChange={e => set('first_placement_bonus', e.target.value)} /></Field>
              <Field label="Residual % year 1"><input style={inputStyle} type="number" step="0.5" min="0" max="100" value={f.residual_pct_y1} onChange={e => set('residual_pct_y1', e.target.value)} /></Field>
              <Field label="Residual % after"><input style={inputStyle} type="number" step="0.5" min="0" max="100" value={f.residual_pct_y2} onChange={e => set('residual_pct_y2', e.target.value)} /></Field>
            </div>
          </>
        )}
        {!partner && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: C.text, margin: '6px 0 14px', cursor: 'pointer' }}>
            <input type="checkbox" checked={f.sendInvite} onChange={e => set('sendInvite', e.target.checked)} /> Email the login invite now
          </label>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" style={btnSecondary} onClick={onClose}>Cancel</button>
          <button type="submit" style={btnPrimary} disabled={busy}>{busy ? 'Saving…' : partner ? 'Save' : 'Add partner'}</button>
        </div>
      </form>
    </Modal>
  );
}

function BankModal({ partner, onClose }) {
  const [bank, setBank] = useState(undefined);
  useEffect(() => { supabase.from('sales_partner_bank').select('*').eq('partner_id', partner.id).maybeSingle().then(({ data }) => setBank(data || null)); }, [partner.id]);
  return (
    <Modal title={`Bank details — ${partner.name}`} onClose={onClose} width={420} dismissible>
      {bank === undefined ? <Spinner size={24} /> : !bank ? <div style={{ color: C.textMuted, fontSize: 13 }}>The partner has not entered bank details yet.</div> : (
        <div><KV k="Account name" v={bank.account_name} /><KV k="BSB" v={bank.bsb} /><KV k="Account no." v={bank.account_no} /><KV k="Updated" v={fmtDateTime(bank.updated_at)} /></div>
      )}
    </Modal>
  );
}

// ── Referrals board ──────────────────────────────────────────────────────────
function Referrals({ d, isMobile, open }) {
  const [filter, setFilter] = useState('open');
  const partnerName = (id) => d.partners.find(p => p.id === id)?.name || '—';
  const closed = (r) => ['completed', 'declined', 'duplicate'].includes(r.status);
  const list = d.referrals.filter(r => !r.archived_at && (filter === 'all' ? true : filter === 'open' ? !closed(r) : filter === 'closed' ? closed(r) : r.status === filter));
  const pending = (r) => d.events.some(e => e.referral_id === r.id && e.kind === 'request_update' && !d.events.some(x => x.referral_id === r.id && x.id > e.id && x.kind !== 'request_update'));
  const segBtn = (on) => ({ ...btnSmall, borderRadius: R.pill, background: on ? C.accentSoft : C.cardHover, borderColor: on ? C.accentBorder : C.border, color: on ? C.text : C.textMuted });
  return (
    <div data-area="referrals board">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {[['open', 'Open'], ['all', 'All'], ['closed', 'Closed'], ...REFERRAL_STATUSES.map(s => [s.id, s.label])].map(([id, l]) => {
          const n = id === 'open' ? list.length && d.referrals.filter(r => !closed(r)).length : REFERRAL_STATUSES.some(s => s.id === id) ? d.referrals.filter(r => r.status === id).length : null;
          if (REFERRAL_STATUSES.some(s => s.id === id) && !n) return null;
          return <button key={id} style={segBtn(filter === id)} onClick={() => setFilter(id)}>{l}{n ? ` ${n}` : ''}</button>;
        })}
      </div>
      {list.length === 0 ? <EmptyState icon="📋" message="No referrals in this view." /> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {list.map(r => (
            <Card key={r.id} onClick={() => open(r.id)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.company_name}{r.is_test ? ' · TEST' : ''}</div>
                  <div style={{ fontSize: 12, color: C.textMuted, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {partnerName(r.partner_id)} · {[...(r.roles || []), r.roles_other].filter(Boolean).join(', ') || '—'} · {r.people_count} ppl
                  </div>
                  <div style={{ fontSize: 11, color: C.textDim, marginTop: 3, fontFamily: MONO }}>{r.start_date ? `from ${fmtDate(r.start_date)}` : ''} · {r.site_address}</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end', flexShrink: 0 }}>
                  <ReferralStatusBadge status={r.status} />
                  {pending(r) && <Badge label="update asked" color="orange" size="sm" />}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ReferralAdminModal({ id, d, isMoneyUser, isMobile, onClose, reload, showToast, currentWorker }) {
  const r = d.referrals.find(x => x.id === id);
  const partner = d.partners.find(p => p.id === r?.partner_id);
  const events = d.events.filter(e => e.referral_id === id);
  const placements = d.placements.filter(p => p.referral_id === id && !p.archived_at);
  const [status, setStatus] = useState(r?.status || 'submitted');
  const [note, setNote] = useState('');
  const [visible, setVisible] = useState(true);
  const [reason, setReason] = useState(r?.declined_reason || '');
  const [reasonVisible, setReasonVisible] = useState(r?.reason_visible || false);
  const [clients, setClients] = useState([]);
  const [sites, setSites] = useState([]);
  const [clientId, setClientId] = useState(r?.client_id || '');
  const [siteId, setSiteId] = useState(r?.site_id || '');
  const [busy, setBusy] = useState(false);
  const [placementModal, setPlacementModal] = useState(null); // null | {} | placement

  useEffect(() => { supabase.from('clients').select('id, name').is('archived_at', null).order('name').then(({ data }) => setClients(data || [])); }, []);
  useEffect(() => {
    if (!clientId) { setSites([]); return; }
    supabase.from('client_sites').select('id, name, address').eq('client_id', clientId).order('name').then(({ data }) => setSites(data || []));
  }, [clientId]);
  if (!r) return null;
  const typeLabel = REFERRAL_TYPES.find(t => t.id === r.referral_type)?.label;
  const sourceLabel = SOURCE_OPTIONS.find(s => s.id === r.source)?.label;

  async function openAttachment() {
    const { data, error } = await supabase.storage.from('partner-referrals').createSignedUrl(r.attachment_path, 600);
    if (error || !data?.signedUrl) { showToast('Could not open the file.', 'error'); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  async function saveLink() {
    const c = clients.find(x => x.id === clientId), s = sites.find(x => x.id === siteId);
    const { error } = await supabase.from('partner_referrals').update({ client_id: clientId || null, client_name_snapshot: c?.name || null, site_id: siteId || null, site_name_snapshot: s?.name || null }).eq('id', r.id);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: 'linked', object_type: 'partner_referral', object_id: r.id, client_id: clientId || null, site_id: siteId || null, after: { name: r.company_name, client: c?.name, site: s?.name } });
    showToast('Linked.', 'success'); reload();
  }

  async function applyStatus() {
    const changed = status !== r.status;
    if (!changed && !note.trim()) { showToast('Pick a new status or type a note.', 'info'); return; }
    if (status === 'declined' && !reason.trim()) { showToast('Give a reason for declining (the partner sees it only if you tick the box).', 'error'); return; }
    setBusy(true);
    if (changed) {
      const upd = { status, declined_reason: status === 'declined' ? reason.trim() : r.declined_reason, reason_visible: status === 'declined' ? reasonVisible : r.reason_visible };
      const { error } = await supabase.from('partner_referrals').update(upd).eq('id', r.id);
      if (error) { setBusy(false); showToast(error.message, 'error'); return; }
    }
    const { error: evErr } = await supabase.from('partner_referral_events').insert([{ referral_id: r.id, kind: changed ? 'status' : 'note', from_status: changed ? r.status : null, to_status: changed ? status : null,
      note: note.trim() || null, visible_to_partner: visible, actor_id: currentWorker?.id || null, actor_name: currentWorker?.name || null }]);
    if (evErr) { setBusy(false); showToast(evErr.message, 'error'); return; }
    if (changed && partner) {
      const firstActive = status === 'active' && !events.some(e => e.kind === 'status' && e.to_status === 'active');
      await notifyPartner({ partner_id: partner.id, kind: firstActive ? 'first_placement' : 'status_changed', referral_id: r.id, text: visible && note.trim() ? note.trim() : undefined });
    }
    setBusy(false); setNote(''); showToast(changed ? `Moved to ${REFERRAL_STATUSES.find(s => s.id === status)?.label}.` : 'Note added.', 'success'); reload();
  }

  return (
    <Modal title={`${r.company_name}${r.is_test ? ' · TEST DATA' : ''}`} onClose={onClose} width={680}>
      <div data-area="referral admin" style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 18 }}>
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <ReferralStatusBadge status={r.status} />
            <span style={{ fontSize: 12, color: C.textMuted }}>from <strong style={{ color: C.text }}>{partner?.name || '—'}</strong></span>
            <span style={{ fontSize: 11, color: C.textDim, fontFamily: MONO }}>{fmtDateTime(r.created_at)}</span>
            {r.attachment_path && <button style={btnSmall} onClick={openAttachment}>📎 Attachment</button>}
          </div>
          <ReferralFacts r={r} typeLabel={typeLabel} sourceLabel={sourceLabel} />
          <SectionTitle>Link to client & site</SectionTitle>
          <div style={{ display: 'grid', gap: 8 }}>
            <select style={inputStyle} value={clientId} onChange={e => { setClientId(e.target.value); setSiteId(''); }}>
              <option value="">— client —</option>{clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select style={inputStyle} value={siteId} onChange={e => setSiteId(e.target.value)} disabled={!clientId}>
              <option value="">— site —</option>{sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button style={btnSecondary} onClick={saveLink} disabled={!clientId}>Save link</button>
          </div>
        </div>
        <div>
          <SectionTitle>Update status</SectionTitle>
          <select style={inputStyle} value={status} onChange={e => setStatus(e.target.value)} data-testid="status-select">
            {REFERRAL_STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          {status === 'declined' && (
            <div style={{ marginTop: 8 }}>
              <input style={inputStyle} value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for declining" />
              <label style={{ fontSize: 12, color: C.textMuted, display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, cursor: 'pointer' }}><input type="checkbox" checked={reasonVisible} onChange={e => setReasonVisible(e.target.checked)} /> Partner can see the reason</label>
            </div>
          )}
          <textarea style={{ ...inputStyle, marginTop: 8, minHeight: 64, resize: 'vertical' }} value={note} onChange={e => setNote(e.target.value)} placeholder="Note (optional)" data-testid="status-note" />
          <label style={{ fontSize: 12, color: C.textMuted, display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, cursor: 'pointer' }}><input type="checkbox" checked={visible} onChange={e => setVisible(e.target.checked)} /> Visible to the partner</label>
          <button style={{ ...btnPrimary, width: '100%', marginTop: 10 }} disabled={busy} onClick={applyStatus} data-testid="apply-status">{busy ? 'Saving…' : 'Save update'}</button>

          {isMoneyUser && (
            <>
              <SectionTitle right={EARNING_STATUSES.includes(r.status) || WON_STATUSES.includes(r.status) ? <button style={btnSmall} onClick={() => setPlacementModal({})} data-testid="add-placement">+ Work period</button> : null}>Work periods</SectionTitle>
              {placements.length === 0 ? <div style={{ fontSize: 12, color: C.textDim }}>{WON_STATUSES.includes(r.status) ? 'None yet. Add a period once people are on site.' : 'Available once the referral is Accepted or later.'}</div> : placements.map(p => (
                <div key={p.id} onClick={() => setPlacementModal(p)} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5, padding: '7px 0', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}>
                  <span style={{ color: C.textMuted }}>{fmtDate(p.period_start)} → {fmtDate(p.period_end)} {p.source === 'portal' ? <Badge label="portal" color="blue" size="sm" /> : null}</span>
                  <span style={{ fontFamily: MONO, color: C.text, whiteSpace: 'nowrap' }}>{money(p.revenue_collected)} · GM {money(Number(p.revenue_collected) - Number(p.cost))}</span>
                </div>
              ))}
            </>
          )}
          <SectionTitle>Timeline</SectionTitle>
          <ReferralTimeline events={events} />
        </div>
      </div>
      {placementModal && <PlacementModal referral={r} partner={partner} placement={placementModal.id ? placementModal : null} onClose={() => setPlacementModal(null)} reload={reload} showToast={showToast} currentWorker={currentWorker} d={d} />}
    </Modal>
  );
}

// ── Placement (work period) + commission recompute ───────────────────────────
async function recomputeFor(partnerId, d, showToast) {
  const [pl, ln, rf] = await Promise.all([
    supabase.from('partner_placements').select('*').eq('partner_id', partnerId),
    supabase.from('partner_commission_lines').select('*').eq('partner_id', partnerId),
    supabase.from('partner_referrals').select('*').eq('partner_id', partnerId),
  ]);
  const partner = d.partners.find(p => p.id === partnerId);
  const { upserts, voids } = recompute({ partner, placements: pl.data || [], referrals: rf.data || [], existingLines: ln.data || [] });
  if (voids.length) { const { error } = await supabase.from('partner_commission_lines').update({ status: 'void' }).in('id', voids); if (error) { showToast(error.message, 'error'); return false; } }
  if (upserts.length) { const { error } = await supabase.from('partner_commission_lines').upsert(upserts, { onConflict: 'placement_id,kind' }); if (error) { showToast(error.message, 'error'); return false; } }
  return true;
}

function PlacementModal({ referral: r, partner, placement: p, onClose, reload, showToast, currentWorker, d }) {
  const [f, setF] = useState({ period_start: p?.period_start || r.start_date || '', period_end: p?.period_end || '', hours: p?.hours ?? '', revenue_billed: p?.revenue_billed ?? '', revenue_collected: p?.revenue_collected ?? '', cost: p?.cost ?? '',
    roles_text: p?.roles_text || [...(r.roles || []), r.roles_other].filter(Boolean).join(', '), notes: p?.notes || '', source: p?.source || 'manual' });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const margin = (parseFloat(f.revenue_collected) || 0) - (parseFloat(f.cost) || 0);

  async function auto() {
    if (!f.period_start || !f.period_end) { showToast('Pick the period first.', 'error'); return; }
    if (!r.client_id) { showToast('Link the referral to a client first (left side).', 'error'); return; }
    setBusy(true);
    try {
      const a = await autoFromPortal(supabase, { clientId: r.client_id, clientName: r.client_name_snapshot, from: f.period_start, to: f.period_end });
      setF(x => ({ ...x, hours: a.hours, revenue_billed: a.revenue_billed, revenue_collected: a.revenue_collected, cost: a.cost, source: 'portal', notes: a.note }));
      showToast(`Pulled ${a.shifts} shifts and ${a.invoices.length} paid invoice(s).`, 'success');
    } catch (e) { showToast(e.message, 'error'); }
    setBusy(false);
  }
  async function save(e) {
    e.preventDefault();
    if (!f.period_start || !f.period_end || f.period_end < f.period_start) { showToast('Check the period dates.', 'error'); return; }
    setBusy(true);
    const row = { referral_id: r.id, partner_id: r.partner_id, client_id: r.client_id || null, client_name_snapshot: r.client_name_snapshot || r.company_name, site_id: r.site_id || null, site_name_snapshot: r.site_name_snapshot || null,
      roles_text: f.roles_text.trim() || null, period_start: f.period_start, period_end: f.period_end, hours: parseFloat(f.hours) || 0, revenue_billed: parseFloat(f.revenue_billed) || 0, revenue_collected: parseFloat(f.revenue_collected) || 0,
      cost: parseFloat(f.cost) || 0, source: f.source, notes: f.notes.trim() || null };
    let error, placementId = p?.id;
    if (p) ({ error } = await supabase.from('partner_placements').update(row).eq('id', p.id));
    else { const res = await supabase.from('partner_placements').insert([{ ...row, created_by: currentWorker?.id || null }]).select('id').single(); error = res.error; placementId = res.data?.id; }
    if (error) { setBusy(false); showToast(error.message, 'error'); return; }
    await supabase.from('partner_referral_events').insert([{ referral_id: r.id, kind: 'placement', note: `${p ? 'Updated' : 'Added'} work period ${f.period_start} → ${f.period_end}`, visible_to_partner: true, actor_id: currentWorker?.id || null, actor_name: currentWorker?.name || null }]);
    logActivity({ verb: p ? 'updated' : 'created', object_type: 'partner_placement', object_id: placementId, client_id: r.client_id || null, after: { name: row.client_name_snapshot, period: `${f.period_start}→${f.period_end}`, revenue_collected: row.revenue_collected, cost: row.cost } });
    const ok = await recomputeFor(r.partner_id, d, showToast);
    setBusy(false);
    if (ok) showToast('Saved and commission recalculated.', 'success');
    reload(); onClose();
  }
  async function archive() {
    if (!window.confirm('Archive this work period? Pending commission on it is voided; approved/paid lines stay.')) return;
    setBusy(true);
    const { error } = await supabase.from('partner_placements').update({ archived_at: new Date().toISOString() }).eq('id', p.id);
    if (error) { setBusy(false); showToast(error.message, 'error'); return; }
    await recomputeFor(r.partner_id, d, showToast);
    setBusy(false); reload(); onClose();
  }
  const g2 = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 };
  return (
    <Modal title={p ? 'Work period' : 'Add work period'} onClose={onClose} width={520}>
      <form onSubmit={save} data-area="placement form">
        <div style={g2}>
          <Field label="From *"><DateField value={f.period_start} onChange={v => set('period_start', v)} /></Field>
          <Field label="To *"><DateField value={f.period_end} onChange={v => set('period_end', v)} /></Field>
        </div>
        <button type="button" style={{ ...btnSecondary, width: '100%', marginBottom: 12 }} disabled={busy} onClick={auto} data-testid="auto-portal">⚡ Auto from portal data (paid invoices + approved timesheets)</button>
        <Field label="Role(s)"><input style={inputStyle} value={f.roles_text} onChange={e => set('roles_text', e.target.value)} /></Field>
        <div style={g2}>
          <Field label="Hours"><input style={inputStyle} type="number" step="0.25" min="0" value={f.hours} onChange={e => set('hours', e.target.value)} data-testid="pl-hours" /></Field>
          <Field label="Revenue billed $"><input style={inputStyle} type="number" step="0.01" min="0" value={f.revenue_billed} onChange={e => set('revenue_billed', e.target.value)} data-testid="pl-billed" /></Field>
          <Field label="Revenue collected $ *" hint="Only paid money earns commission."><input style={inputStyle} type="number" step="0.01" min="0" value={f.revenue_collected} onChange={e => set('revenue_collected', e.target.value)} data-testid="pl-collected" /></Field>
          <Field label="Fully loaded cost $ *"><input style={inputStyle} type="number" step="0.01" min="0" value={f.cost} onChange={e => set('cost', e.target.value)} data-testid="pl-cost" /></Field>
        </div>
        <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 10 }}>Gross margin: <strong style={{ color: margin >= 0 ? C.text : '#fca5a5', fontFamily: MONO }}>{money(margin)}</strong>{partner ? ` · residual ${Number(partner.residual_pct_y1)}% / ${Number(partner.residual_pct_y2)}%` : ''}</div>
        <Field label="Notes"><textarea style={{ ...inputStyle, minHeight: 56, resize: 'vertical' }} value={f.notes} onChange={e => set('notes', e.target.value)} /></Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          {p ? <button type="button" style={btnDanger} disabled={busy} onClick={archive}>Archive period</button> : <span />}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={btnSecondary} onClick={onClose}>Cancel</button>
            <button type="submit" style={btnPrimary} disabled={busy} data-testid="save-placement">{busy ? 'Saving…' : 'Save + recalc'}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ── Commission admin ─────────────────────────────────────────────────────────
function CommissionAdmin({ d, isMobile, reload, showToast, currentWorker }) {
  const [filter, setFilter] = useState('pending');
  const [payFor, setPayFor] = useState(null);
  const [busy, setBusy] = useState(false);
  const pById = Object.fromEntries(d.placements.map(p => [p.id, p]));
  const rById = Object.fromEntries(d.referrals.map(r => [r.id, r]));
  const partnerName = (id) => d.partners.find(p => p.id === id)?.name || '—';
  const list = d.lines.filter(l => filter === 'all' ? l.status !== 'void' : l.status === filter);
  const tot = (st) => d.lines.filter(l => l.status === st).reduce((a, l) => a + Number(l.amount || 0), 0);

  async function approve(l) {
    setBusy(true);
    const { error } = await supabase.from('partner_commission_lines').update({ status: 'approved', approved_by: currentWorker?.id || null, approved_at: new Date().toISOString() }).eq('id', l.id);
    if (error) { setBusy(false); showToast(error.message, 'error'); return; }
    const p = pById[l.placement_id];
    await supabase.from('partner_referral_events').insert([{ referral_id: p?.referral_id, kind: 'commission', note: `Commission approved: ${l.kind === 'bonus' ? 'first placement bonus' : 'residual'} ${money(l.amount)}`, visible_to_partner: true, actor_id: currentWorker?.id || null, actor_name: currentWorker?.name || null }]);
    await notifyPartner({ partner_id: l.partner_id, kind: 'commission_approved', referral_id: p?.referral_id, text: `${l.kind === 'bonus' ? 'first placement bonus' : 'residual'} ${money(l.amount)}` });
    setBusy(false); showToast('Approved.', 'success'); reload();
  }
  async function voidLine(l) {
    if (!window.confirm('Void this pending line? It is kept for the audit trail and recomputed on the next change.')) return;
    const { error } = await supabase.from('partner_commission_lines').update({ status: 'void' }).eq('id', l.id);
    if (error) showToast(error.message, 'error'); reload();
  }
  async function recomputeAll() {
    setBusy(true);
    for (const p of d.partners.filter(x => x.status !== 'archived')) await recomputeFor(p.id, d, showToast);
    setBusy(false); showToast('Recalculated for every partner.', 'success'); reload();
  }
  const segBtn = (on) => ({ ...btnSmall, borderRadius: R.pill, background: on ? C.accentSoft : C.cardHover, borderColor: on ? C.accentBorder : C.border, color: on ? C.text : C.textMuted });
  const csv = () => downloadCSV('partner-commission.csv', list.map(l => { const p = pById[l.placement_id] || {}; return { Partner: partnerName(l.partner_id), Client: p.client_name_snapshot || rById[p.referral_id]?.company_name || '', Period: p.period_start ? `${p.period_start} → ${p.period_end}` : '', Type: l.kind, Rate: l.rate, 'Base $': l.base_amount, 'Commission $': l.amount, Status: l.status, 'Approved': l.approved_at || '', 'Paid': l.paid_at || '', 'Payment ref': l.payment_ref || '' }; }));

  return (
    <div data-area="commission admin">
      <StatGrid cols={isMobile ? 2 : 4}>
        <StatCard label="Pending" value={money(tot('pending'))} accent />
        <StatCard label="Approved" value={money(tot('approved'))} sub="next pay run" />
        <StatCard label="Paid" value={money(tot('paid'))} sub="lifetime" />
        <StatCard label="Collected revenue" value={money(d.placements.filter(p => !p.archived_at).reduce((a, p) => a + Number(p.revenue_collected || 0), 0))} sub="from referred work" />
      </StatGrid>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '14px 0 10px', alignItems: 'center' }}>
        {[['pending', 'Pending'], ['approved', 'Approved'], ['paid', 'Paid'], ['all', 'All']].map(([id, l]) => <button key={id} style={segBtn(filter === id)} onClick={() => setFilter(id)}>{l}</button>)}
        <span style={{ flex: 1 }} />
        <button style={btnSmall} onClick={csv}>⬇ CSV</button>
        <button style={btnSmall} disabled={busy} onClick={recomputeAll}>↻ Recalculate</button>
      </div>
      {list.length === 0 ? <EmptyState icon="💰" message="No commission lines in this view." /> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {list.map(l => {
            const p = pById[l.placement_id] || {}; const r = rById[p.referral_id] || {};
            return (
              <Card key={l.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{partnerName(l.partner_id)} <span style={{ color: C.textMuted, fontWeight: 400 }}>· {p.client_name_snapshot || r.company_name || '—'}</span></div>
                    <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{l.kind === 'bonus' ? 'First placement bonus' : `Residual ${Number(l.rate)}% of ${money(l.base_amount)} margin`} · {p.period_start ? `${fmtDate(p.period_start)} → ${fmtDate(p.period_end)}` : ''}</div>
                    {l.calc?.formula && <div style={{ fontSize: 11, color: C.textDim, fontFamily: MONO, marginTop: 2 }}>{l.calc.formula}</div>}
                    {l.paid_at && <div style={{ fontSize: 11, color: C.textDim, fontFamily: MONO, marginTop: 2 }}>paid {fmtDate(l.paid_at)}{l.payment_ref ? ` · ref ${l.payment_ref}` : ''}</div>}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                    <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: C.text }}>{money(l.amount)}</div>
                    <CommissionStatusBadge status={l.status} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                  {l.status === 'pending' && <button style={btnPrimary} disabled={busy} onClick={() => approve(l)} data-testid={`approve-${l.id}`}>Approve</button>}
                  {l.status === 'approved' && <button style={btnPrimary} disabled={busy} onClick={() => setPayFor(l)} data-testid={`pay-${l.id}`}>Mark paid</button>}
                  {l.status === 'pending' && <button style={btnSmall} onClick={() => voidLine(l)}>Void</button>}
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {payFor && <PayModal line={payFor} placement={pById[payFor.placement_id]} onClose={() => setPayFor(null)} reload={reload} showToast={showToast} currentWorker={currentWorker} />}
    </div>
  );
}

function PayModal({ line: l, placement: p, onClose, reload, showToast, currentWorker }) {
  const [ref, setRef] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    if (!ref.trim()) { showToast('Payment reference is required.', 'error'); return; }
    setBusy(true);
    const { error } = await supabase.from('partner_commission_lines').update({ status: 'paid', paid_at: `${date}T12:00:00+10:00`, payment_ref: ref.trim() }).eq('id', l.id);
    if (error) { setBusy(false); showToast(error.message, 'error'); return; }
    await supabase.from('partner_referral_events').insert([{ referral_id: p?.referral_id, kind: 'commission', note: `Commission paid: ${money(l.amount)} · ref ${ref.trim()}`, visible_to_partner: true, actor_id: currentWorker?.id || null, actor_name: currentWorker?.name || null }]);
    await notifyPartner({ partner_id: l.partner_id, kind: 'commission_paid', referral_id: p?.referral_id, text: `${money(l.amount)} · ref ${ref.trim()}` });
    setBusy(false); showToast('Marked paid.', 'success'); reload(); onClose();
  }
  return (
    <Modal title={`Mark paid — ${money(l.amount)}`} onClose={onClose} width={400}>
      <form onSubmit={save}>
        <Field label="Paid on"><DateField value={date} onChange={setDate} /></Field>
        <Field label="Payment reference *"><input style={inputStyle} value={ref} onChange={e => setRef(e.target.value)} placeholder="Bank ref / batch no." autoFocus data-testid="payment-ref" /></Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" style={btnSecondary} onClick={onClose}>Cancel</button>
          <button type="submit" style={btnPrimary} disabled={busy} data-testid="confirm-paid">{busy ? 'Saving…' : 'Mark paid'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ── Reports ──────────────────────────────────────────────────────────────────
function Reports({ d, isMoneyUser, isMobile }) {
  const rep = useMemo(() => partnerReport({ partners: d.partners.filter(p => p.status !== 'archived'), referrals: d.referrals.filter(r => !r.archived_at), placements: d.placements, lines: d.lines }), [d]);
  const funnel = REFERRAL_STATUSES.map(s => ({ ...s, n: d.referrals.filter(r => r.status === s.id && !r.archived_at).length }));
  const csv = () => downloadCSV('sales-partner-report.csv', rep.rows.map(r => ({ Partner: r.partner, Company: r.company, Status: r.status, Referrals: r.referrals, Won: r.won, 'Conversion %': r.conversion_pct, Active: r.active,
    ...(isMoneyUser ? { 'Revenue collected $': r.revenue_collected, 'Gross margin $': r.gross_margin, 'Commission pending $': r.commission_pending, 'Commission approved $': r.commission_approved, 'Commission paid $': r.commission_paid } : {}) })));
  return (
    <div data-area="partner reports">
      <StatGrid cols={isMobile ? 2 : 4}>
        <StatCard label="Referrals" value={rep.totals.referrals} sub={`${rep.totals.active} active now`} />
        <StatCard label="Conversion" value={`${rep.totals.conversion_pct}%`} sub={`${rep.totals.won} accepted or better`} />
        {isMoneyUser && <StatCard label="Revenue collected" value={money(rep.totals.revenue_collected)} sub={`GM ${money(rep.totals.gross_margin)}`} />}
        {isMoneyUser && <StatCard label="Commission paid" value={money(rep.totals.commission_paid)} sub={`${money(rep.totals.commission_pending)} pending`} accent />}
      </StatGrid>
      <SectionTitle right={<button style={btnSmall} onClick={csv}>⬇ CSV</button>}>By partner</SectionTitle>
      {rep.rows.length === 0 ? <EmptyState icon="📁" message="No partners yet." /> : (
        <TableWrap>
          <thead><tr><Th>Partner</Th><Th align="right">Referrals</Th><Th align="right">Won</Th><Th align="right">Conv.</Th>{isMoneyUser && <><Th align="right">Collected $</Th><Th align="right">GM $</Th><Th align="right">Paid $</Th><Th align="right">Pending $</Th></>}</tr></thead>
          <tbody>{rep.rows.map(r => (
            <tr key={r.partner_id}>
              <Td><strong>{r.partner}</strong>{r.company ? <div style={{ fontSize: 11, color: C.textDim }}>{r.company}</div> : null}</Td>
              <Td align="right" style={{ fontFamily: MONO }}>{r.referrals}</Td><Td align="right" style={{ fontFamily: MONO }}>{r.won}</Td><Td align="right" style={{ fontFamily: MONO }}>{r.conversion_pct}%</Td>
              {isMoneyUser && <><Td align="right" style={{ fontFamily: MONO }}>{r.revenue_collected.toFixed(2)}</Td><Td align="right" style={{ fontFamily: MONO }}>{r.gross_margin.toFixed(2)}</Td><Td align="right" style={{ fontFamily: MONO }}>{r.commission_paid.toFixed(2)}</Td><Td align="right" style={{ fontFamily: MONO }}>{r.commission_pending.toFixed(2)}</Td></>}
            </tr>))}
          </tbody>
        </TableWrap>
      )}
      <SectionTitle>Funnel</SectionTitle>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {funnel.map(s => <div key={s.id} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', background: C.card, border: `1px solid ${C.border}`, borderRadius: R.pill, padding: '5px 10px' }}><ReferralStatusBadge status={s.id} size="sm" /><span style={{ fontFamily: MONO, fontSize: 12, color: C.text }}>{s.n}</span></div>)}
      </div>
    </div>
  );
}
