import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnDanger, btnSmall } from '../../theme';
import { todayISO } from '../../utils/dates';
import { downloadCSV } from '../../utils/csv';
import { useDraft, DraftBanner } from '../../utils/useDraft';
import { Spinner, Modal, Field, TableWrap, Th, Td, EmptyState } from '../../components';

const clientDefaults = {
  name: '', site: '', contact: '', contact_email: '', contact_phone: '',
  rate_a: '', rate_b: '', rate_c: '',
  charge_travel: '', charge_meal: '', notes: '',
};

const rateCardDefaults = { role_name: '', rate_a: '', rate_b: '', rate_c: '', notes: '' };

const jobDefaults = {
  name: '', description: '', site: '', address: '',
  start_date: '', end_date: '', status: 'active',
  required_roles: [], notes: '',
};

const STATUS_COLORS = {
  active:    { bg: 'rgba(34,197,94,0.15)',   color: '#22c55e' },
  on_hold:   { bg: 'rgba(234,179,8,0.15)',   color: '#eab308' },
  completed: { bg: 'rgba(19,181,234,0.15)',  color: '#13B5EA' },
  cancelled: { bg: 'rgba(239,68,68,0.12)',   color: '#ef4444' },
};

function StatusBadge({ status }) {
  const s = STATUS_COLORS[status] || STATUS_COLORS.active;
  return (
    <span style={{ background: s.bg, color: s.color, borderRadius: 5, padding: '2px 8px', fontSize: 11, fontWeight: 600, fontFamily: '"DM Mono", monospace', textTransform: 'capitalize' }}>
      {status?.replace('_', ' ') || 'active'}
    </span>
  );
}

export function ClientsPage({ showToast }) {
  const [tab, setTab] = useState('clients');

  return (
    <div>
      <div style={{ display: 'flex', gap: 2, borderBottom: `1px solid ${C.border}`, marginBottom: 20 }}>
        {[{ id: 'clients', label: 'Clients' }, { id: 'job_roles', label: 'Job Roles' }].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: 'none', border: 'none', borderBottom: tab === t.id ? `2px solid ${C.accent}` : '2px solid transparent',
            color: tab === t.id ? C.text : C.textMuted, padding: '8px 16px', cursor: 'pointer',
            fontSize: 13, fontWeight: tab === t.id ? 600 : 400, marginBottom: -1,
          }}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'clients'    && <ClientsList showToast={showToast} />}
      {tab === 'job_roles'  && <JobRolesList showToast={showToast} />}
    </div>
  );
}

// ── Clients list ─────────────────────────────────────────────────────────────

function ClientsList({ showToast }) {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const draftKey = modal === 'add'
    ? 'client_add'
    : modal && typeof modal === 'object'
      ? `client_edit_${modal.id}`
      : 'client_disabled';
  const [form, setForm, draft] = useDraft(draftKey, clientDefaults, { enabled: !!modal });
  const [saving, setSaving] = useState(false);
  const [jobsClient, setJobsClient] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('clients')
      .select('*, client_jobs(id), client_rate_cards(id)')
      .order('name');
    if (error) showToast(error.message, 'error');
    else setClients(data || []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const openAdd  = () => { setModal('add'); };
  const openEdit = (c) => {
    setModal(c);
    setForm({
      name: c.name, site: c.site || '', contact: c.contact || '',
      contact_email: c.contact_email || '', contact_phone: c.contact_phone || '',
      rate_a: c.rate_a ?? c.rate_regular ?? '',
      rate_b: c.rate_b ?? c.rate_overtime ?? c.rate_night ?? '',
      rate_c: c.rate_c ?? c.rate_weekend ?? '',
      charge_travel: c.charge_travel ?? '', charge_meal: c.charge_meal ?? '',
      notes: c.notes || '',
    });
  };
  const closeModal = () => { draft.clear(); setModal(null); };

  const handleSave = async () => {
    if (!form.name.trim()) { showToast('Client name is required.', 'error'); return; }
    setSaving(true);
    const n = v => v === '' ? null : parseFloat(v);
    const A = n(form.rate_a);
    const payload = {
      name: form.name, site: form.site, contact: form.contact,
      contact_email: form.contact_email, contact_phone: form.contact_phone,
      rate_a: A,
      rate_b: n(form.rate_b) ?? (A != null ? +(A * 1.5).toFixed(2) : null),
      rate_c: n(form.rate_c) ?? (A != null ? +(A * 2).toFixed(2)   : null),
      // Keep legacy columns in sync for payroll calc backward compat.
      rate_regular:  A,
      rate_overtime: n(form.rate_b) ?? (A != null ? +(A * 1.5).toFixed(2) : null),
      rate_night:    n(form.rate_b) ?? (A != null ? +(A * 1.5).toFixed(2) : null),
      rate_weekend:  n(form.rate_c) ?? (A != null ? +(A * 2).toFixed(2)   : null),
      charge_travel: n(form.charge_travel), charge_meal: n(form.charge_meal),
      notes: form.notes,
    };
    if (modal === 'add') {
      const { error } = await supabase.from('clients').insert([payload]);
      if (error) showToast(error.message, 'error');
      else { showToast('Client added', 'success'); closeModal(); load(); }
    } else {
      const { error } = await supabase.from('clients').update(payload).eq('id', modal.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Client updated', 'success'); closeModal(); load(); }
    }
    setSaving(false);
  };

  const handleDelete = async (c) => {
    if (!window.confirm(`Delete client "${c.name}"? All their jobs and rate cards will also be deleted.`)) return;
    const { error } = await supabase.from('clients').delete().eq('id', c.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Client deleted', 'success'); load(); }
  };

  const handleExport = async () => {
    const { data, error } = await supabase.from('clients').select('*');
    if (error) { showToast(error.message, 'error'); return; }
    downloadCSV(`clients_export_${todayISO()}.csv`, data);
    showToast('Clients exported', 'success');
  };

  const filtered = clients.filter(c =>
    !search ||
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.site || '').toLowerCase().includes(search.toLowerCase()) ||
    (c.contact || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <input style={{ ...inputStyle, maxWidth: 280 }} placeholder="Search by name, site, contact…" value={search} onChange={e => setSearch(e.target.value)} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleExport} style={btnSecondary}>↓ Export CSV</button>
          <button onClick={openAdd} style={btnPrimary}>+ Add Client</button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>
      ) : filtered.length === 0 ? (
        <EmptyState message="No clients yet. Add your first client to get started." />
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>Client Name</Th><Th>Site</Th><Th>Contact</Th><Th>Phone</Th>
              <Th>Default A · B · C</Th><Th>Roles</Th><Th>Jobs</Th><Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(c => (
              <tr key={c.id}>
                <Td><strong>{c.name}</strong></Td>
                <Td>{c.site || '—'}</Td>
                <Td>
                  <div>{c.contact || '—'}</div>
                  {c.contact_email && <div style={{ fontSize: 12, color: C.textMuted }}>{c.contact_email}</div>}
                </Td>
                <Td>{c.contact_phone || '—'}</Td>
                <Td>
                  {(c.rate_a ?? c.rate_regular) != null
                    ? <span style={{ fontFamily: '"DM Mono", monospace', fontSize: 12, color: C.accent, fontWeight: 700 }}>
                        ${parseFloat(c.rate_a ?? c.rate_regular).toFixed(0)} · ${parseFloat(c.rate_b ?? c.rate_overtime ?? 0).toFixed(0)} · ${parseFloat(c.rate_c ?? c.rate_weekend ?? 0).toFixed(0)}
                      </span>
                    : <span style={{ color: C.textMuted }}>—</span>}
                </Td>
                <Td>
                  <button
                    onClick={() => setJobsClient({ ...c, _initialTab: 'rates' })}
                    style={{ ...btnSmall, background: 'rgba(34,197,94,0.12)', color: C.success, border: 'none' }}
                    title="Per-role rate cards"
                  >
                    Roles {c.client_rate_cards?.length > 0 ? `(${c.client_rate_cards.length})` : ''}
                  </button>
                </Td>
                <Td>
                  <button
                    onClick={() => setJobsClient({ ...c, _initialTab: 'jobs' })}
                    style={{ ...btnSmall, background: 'rgba(249,115,22,0.12)', color: C.accent, border: 'none' }}
                  >
                    Jobs {c.client_jobs?.length > 0 ? `(${c.client_jobs.length})` : ''}
                  </button>
                </Td>
                <Td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => openEdit(c)} style={btnSmall}>Edit</button>
                    <button onClick={() => handleDelete(c)} style={btnDanger}>Delete</button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      {/* Client add/edit modal */}
      {modal && (
        <Modal title={modal === 'add' ? 'Add Client' : 'Edit Client'} onClose={closeModal} width={600}>
          <DraftBanner
            visible={draft.draftRestored}
            onDiscard={() => { draft.discardDraft(); setForm(clientDefaults); }}
            onDismiss={draft.dismissBanner}
            label={modal === 'add' ? 'Unsaved draft restored.' : 'Unsaved edits to this client were restored.'}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Client Name *"><input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></Field>
            </div>
            <Field label="Site / Project"><input style={inputStyle} value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} /></Field>
            <Field label="Contact Person"><input style={inputStyle} value={form.contact} onChange={e => setForm(f => ({ ...f, contact: e.target.value }))} /></Field>
            <Field label="Contact Email"><input style={inputStyle} type="email" value={form.contact_email} onChange={e => setForm(f => ({ ...f, contact_email: e.target.value }))} /></Field>
            <Field label="Contact Phone"><input style={inputStyle} value={form.contact_phone} onChange={e => setForm(f => ({ ...f, contact_phone: e.target.value }))} /></Field>

            <div style={{ gridColumn: '1 / -1', marginTop: 4 }}>
              <div style={{ background: 'rgba(249,115,22,0.06)', border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.accent, letterSpacing: 1, marginBottom: 8 }}>
                  💵 DEFAULT CHARGE BANDS ($/hr)
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  <Field label="A — Normal (Mon–Fri ≤8h)">
                    <input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_a}
                      onChange={e => setForm(f => ({ ...f, rate_a: e.target.value }))}
                      onBlur={() => {
                        const A = parseFloat(form.rate_a);
                        if (!isNaN(A)) setForm(f => ({
                          ...f,
                          rate_b: f.rate_b === '' ? (A * 1.5).toFixed(2) : f.rate_b,
                          rate_c: f.rate_c === '' ? (A * 2).toFixed(2)   : f.rate_c,
                        }));
                      }}
                      placeholder="e.g. 68.00" />
                  </Field>
                  <Field label="B — OT 1.5× (night/Sat day)">
                    <input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_b}
                      onChange={e => setForm(f => ({ ...f, rate_b: e.target.value }))}
                      placeholder="auto" />
                  </Field>
                  <Field label="C — OT 2× (Sun/PH/Sat >8h)">
                    <input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_c}
                      onChange={e => setForm(f => ({ ...f, rate_c: e.target.value }))}
                      placeholder="auto" />
                  </Field>
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
                  These are <strong>defaults</strong>. Add per-role rate cards (e.g. Operator, Skilled Labour) under <strong>Roles</strong> on the client row to override per role.
                </div>
              </div>
            </div>

            <Field label="Travel Charge ($)"><input style={inputStyle} type="number" step="0.01" min="0" value={form.charge_travel} onChange={e => setForm(f => ({ ...f, charge_travel: e.target.value }))} /></Field>
            <Field label="Meal Charge ($)"><input style={inputStyle} type="number" step="0.01" min="0" value={form.charge_meal} onChange={e => setForm(f => ({ ...f, charge_meal: e.target.value }))} /></Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Notes"><textarea style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></Field>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={closeModal} style={btnSecondary}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}

      {/* Jobs + Rate Cards panel modal */}
      {jobsClient && (
        <ClientDetailModal
          client={jobsClient}
          initialTab={jobsClient._initialTab || 'jobs'}
          showToast={showToast}
          onClose={() => { setJobsClient(null); load(); }}
        />
      )}
    </>
  );
}

// ── Client Detail Modal: tabs for Jobs and Roles/Rates ──────────────────────

function ClientDetailModal({ client, initialTab, showToast, onClose }) {
  const [tab, setTab] = useState(initialTab);

  return (
    <Modal title={`${client.name}`} onClose={onClose} width={760}>
      <div style={{ display: 'flex', gap: 2, borderBottom: `1px solid ${C.border}`, marginBottom: 16, marginTop: -8 }}>
        {[
          { id: 'jobs', label: '📋 Jobs' },
          { id: 'rates', label: '💰 Roles & Rates' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: 'none', border: 'none',
            borderBottom: tab === t.id ? `2px solid ${C.accent}` : '2px solid transparent',
            color: tab === t.id ? C.text : C.textMuted, padding: '8px 14px', cursor: 'pointer',
            fontSize: 13, fontWeight: tab === t.id ? 600 : 400, marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>
      {tab === 'jobs'  && <JobsPanel  client={client} showToast={showToast} />}
      {tab === 'rates' && <RatesPanel client={client} showToast={showToast} />}
    </Modal>
  );
}

// ── Per-client Rate Cards (per role) ────────────────────────────────────────

function RatesPanel({ client, showToast }) {
  const [cards, setCards] = useState([]);
  const [allRoles, setAllRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | 'add' | cardObj
  const draftKey = editing === 'add'
    ? `rate_card_add_${client.id}`
    : editing && typeof editing === 'object'
      ? `rate_card_edit_${editing.id}`
      : 'rate_card_disabled';
  const [form, setForm, draft] = useDraft(draftKey, rateCardDefaults, { enabled: !!editing });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [c, r] = await Promise.all([
      supabase.from('client_rate_cards').select('*').eq('client_id', client.id).order('role_name'),
      supabase.from('job_roles').select('*').order('name'),
    ]);
    if (c.data) setCards(c.data);
    if (r.data) setAllRoles(r.data);
    setLoading(false);
  }, [client.id]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setEditing('add'); };
  const openEdit = (card) => {
    setEditing(card);
    setForm({
      role_name: card.role_name, rate_a: card.rate_a ?? '', rate_b: card.rate_b ?? '',
      rate_c: card.rate_c ?? '', notes: card.notes || '',
    });
  };
  const close = () => { draft.clear(); setEditing(null); };

  const handleSave = async () => {
    if (!form.role_name.trim()) { showToast('Pick a role first.', 'error'); return; }
    if (form.rate_a === '') { showToast('Rate A is required.', 'error'); return; }
    setSaving(true);
    const n = v => v === '' ? null : parseFloat(v);
    const A = n(form.rate_a);
    const payload = {
      client_id: client.id,
      role_name: form.role_name.trim(),
      rate_a: A,
      rate_b: n(form.rate_b) ?? +(A * 1.5).toFixed(2),
      rate_c: n(form.rate_c) ?? +(A * 2).toFixed(2),
      notes: form.notes || null,
    };
    if (editing === 'add') {
      const { error } = await supabase.from('client_rate_cards').insert([payload]);
      if (error) showToast(error.message, 'error');
      else { showToast('Rate card added', 'success'); close(); load(); }
    } else {
      const { error } = await supabase.from('client_rate_cards').update(payload).eq('id', editing.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Rate card updated', 'success'); close(); load(); }
    }
    setSaving(false);
  };

  const handleDelete = async (card) => {
    if (!window.confirm(`Remove rate card "${card.role_name}"?`)) return;
    const { error } = await supabase.from('client_rate_cards').delete().eq('id', card.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Rate card removed', 'success'); load(); }
  };

  const usedRoles = new Set(cards.map(c => c.role_name));
  const availableRoles = allRoles.filter(r => !usedRoles.has(r.name) || (editing && editing.role_name === r.name));

  return (
    <div>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>
        Each role can have its own A / B / C rate for this client. If a role has no rate card here, the client's default bands apply.
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
        <button onClick={openAdd} style={btnPrimary} disabled={!!editing}>+ Add Role Rate</button>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 28 }}><Spinner /></div>
      ) : cards.length === 0 && !editing ? (
        <EmptyState message="No per-role rate cards yet. Use the defaults from the client's profile, or add a role-specific rate." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {cards.map(c => (
            <div key={c.id} style={{
              background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
              padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
            }}>
              <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{c.role_name}</div>
                {c.notes && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{c.notes}</div>}
              </div>
              <div style={{ display: 'flex', gap: 14, fontFamily: '"DM Mono", monospace', fontSize: 13 }}>
                <span><span style={{ color: C.textMuted, fontSize: 10 }}>A </span><strong style={{ color: C.accent }}>${parseFloat(c.rate_a || 0).toFixed(2)}</strong></span>
                <span><span style={{ color: C.textMuted, fontSize: 10 }}>B </span><strong style={{ color: C.accent }}>${parseFloat(c.rate_b || 0).toFixed(2)}</strong></span>
                <span><span style={{ color: C.textMuted, fontSize: 10 }}>C </span><strong style={{ color: C.accent }}>${parseFloat(c.rate_c || 0).toFixed(2)}</strong></span>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => openEdit(c)} style={btnSmall} disabled={!!editing}>Edit</button>
                <button onClick={() => handleDelete(c)} style={btnDanger}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div style={{ marginTop: 18, background: C.card, border: `1px solid ${C.accent}`, borderRadius: 10, padding: 18 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 12 }}>
            {editing === 'add' ? 'New Role Rate Card' : `Edit: ${editing.role_name}`}
          </div>
          <DraftBanner
            visible={draft.draftRestored}
            onDiscard={() => { draft.discardDraft(); setForm(rateCardDefaults); }}
            onDismiss={draft.dismissBanner}
            label="Unsaved rate-card draft restored."
          />
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 12 }}>
            <Field label="Role">
              <>
                <input style={inputStyle} list={`roles-list-${client.id}`}
                  value={form.role_name}
                  onChange={e => setForm(f => ({ ...f, role_name: e.target.value }))}
                  placeholder="Type or pick a role…" />
                <datalist id={`roles-list-${client.id}`}>
                  {availableRoles.map(r => <option key={r.id} value={r.name} />)}
                </datalist>
              </>
            </Field>
            <Field label="A — Normal">
              <input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_a}
                onChange={e => setForm(f => ({ ...f, rate_a: e.target.value }))}
                onBlur={() => {
                  const A = parseFloat(form.rate_a);
                  if (!isNaN(A)) setForm(f => ({
                    ...f,
                    rate_b: f.rate_b === '' ? (A * 1.5).toFixed(2) : f.rate_b,
                    rate_c: f.rate_c === '' ? (A * 2).toFixed(2)   : f.rate_c,
                  }));
                }}
                placeholder="e.g. 68" />
            </Field>
            <Field label="B — OT 1.5×">
              <input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_b}
                onChange={e => setForm(f => ({ ...f, rate_b: e.target.value }))} placeholder="auto" />
            </Field>
            <Field label="C — OT 2×">
              <input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_c}
                onChange={e => setForm(f => ({ ...f, rate_c: e.target.value }))} placeholder="auto" />
            </Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Notes"><input style={inputStyle} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="e.g. Wet weather inclusive" /></Field>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={close} style={btnSecondary}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Jobs panel for a specific client ─────────────────────────────────────────

function JobsPanel({ client, showToast }) {
  const [jobs, setJobs] = useState([]);
  const [allRoles, setAllRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const draftKey = modal === 'add'
    ? `client_job_add_${client.id}`
    : modal && typeof modal === 'object'
      ? `client_job_edit_${modal.id}`
      : 'client_job_disabled';
  const [form, setForm, draft] = useDraft(draftKey, jobDefaults, { enabled: !!modal });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [j, r] = await Promise.all([
      supabase.from('client_jobs').select('*').eq('client_id', client.id).order('created_at', { ascending: false }),
      supabase.from('job_roles').select('*').order('name'),
    ]);
    if (j.data) setJobs(j.data);
    if (r.data) setAllRoles(r.data);
    setLoading(false);
  }, [client.id]);

  useEffect(() => { load(); }, [load]);

  const openAdd  = () => { setModal('add'); };
  const openEdit = (j) => {
    setModal(j);
    setForm({
      name: j.name, description: j.description || '', site: j.site || '',
      address: j.address || '', start_date: j.start_date || '',
      end_date: j.end_date || '', status: j.status || 'active',
      required_roles: j.required_roles || [], notes: j.notes || '',
    });
  };
  const closeJobModal = () => { draft.clear(); setModal(null); };

  const toggleRole = (roleName) => {
    setForm(f => ({
      ...f,
      required_roles: f.required_roles.includes(roleName)
        ? f.required_roles.filter(r => r !== roleName)
        : [...f.required_roles, roleName],
    }));
  };

  const handleSave = async () => {
    if (!form.name.trim()) { showToast('Job name is required.', 'error'); return; }
    setSaving(true);
    const payload = {
      ...form,
      client_id: client.id,
      start_date: form.start_date || null,
      end_date:   form.end_date   || null,
    };
    if (modal === 'add') {
      const { error } = await supabase.from('client_jobs').insert([payload]);
      if (error) showToast(error.message, 'error');
      else { showToast('Job added', 'success'); closeJobModal(); load(); }
    } else {
      const { error } = await supabase.from('client_jobs').update(payload).eq('id', modal.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Job updated', 'success'); closeJobModal(); load(); }
    }
    setSaving(false);
  };

  const handleDelete = async (j) => {
    if (!window.confirm(`Delete job "${j.name}"?`)) return;
    const { error } = await supabase.from('client_jobs').delete().eq('id', j.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Job deleted', 'success'); load(); }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
        <button onClick={openAdd} style={btnPrimary}>+ Add Job</button>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 28 }}><Spinner /></div>
      ) : jobs.length === 0 ? (
        <EmptyState message="No jobs yet for this client. Add the first one." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {jobs.map(j => (
            <div key={j.id} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{j.name}</span>
                    <StatusBadge status={j.status} />
                  </div>
                  {j.description && <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4 }}>{j.description}</div>}
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: C.textMuted }}>
                    {j.site    && <span>📍 {j.site}</span>}
                    {j.address && <span>🏠 {j.address}</span>}
                    {j.start_date && <span>📅 {j.start_date}{j.end_date ? ` → ${j.end_date}` : ''}</span>}
                  </div>
                  {j.required_roles?.length > 0 && (
                    <div style={{ marginTop: 8, display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                      {j.required_roles.map(r => (
                        <span key={r} style={{ background: 'rgba(249,115,22,0.12)', color: C.accent, borderRadius: 5, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
                          {r}
                        </span>
                      ))}
                    </div>
                  )}
                  {j.notes && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6, fontStyle: 'italic' }}>{j.notes}</div>}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button onClick={() => openEdit(j)} style={btnSmall}>Edit</button>
                  <button onClick={() => handleDelete(j)} style={{ ...btnSmall, background: 'rgba(239,68,68,0.12)', color: '#ef4444', border: 'none' }}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <div style={{ marginTop: 20, background: C.card, border: `1px solid ${C.accent}`, borderRadius: 10, padding: 20 }}>
          <div style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 14 }}>
            {modal === 'add' ? 'New Job' : `Edit: ${modal.name}`}
          </div>
          <DraftBanner
            visible={draft.draftRestored}
            onDiscard={() => { draft.discardDraft(); setForm(jobDefaults); }}
            onDismiss={draft.dismissBanner}
            label="Unsaved job draft restored."
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Job Name *"><input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Rail Corridor Maintenance – Eastern Line" /></Field>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Description"><input style={inputStyle} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></Field>
            </div>
            <Field label="Site"><input style={inputStyle} value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} /></Field>
            <Field label="Address"><input style={inputStyle} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></Field>
            <Field label="Start Date"><input style={inputStyle} type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} /></Field>
            <Field label="End Date"><input style={inputStyle} type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} /></Field>
            <Field label="Status">
              <select style={inputStyle} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                <option value="active">Active</option>
                <option value="on_hold">On Hold</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Required Roles">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {allRoles.map(r => {
                    const selected = form.required_roles.includes(r.name);
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => toggleRole(r.name)}
                        style={{
                          padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                          cursor: 'pointer', border: `1px solid ${selected ? C.accent : C.border}`,
                          background: selected ? 'rgba(249,115,22,0.15)' : 'transparent',
                          color: selected ? C.accent : C.textMuted,
                          transition: 'all 0.1s',
                        }}
                      >
                        {selected ? '✓ ' : ''}{r.name}
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Click to toggle which roles are needed for this job</div>
              </Field>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Notes"><textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></Field>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 10 }}>
            <button onClick={closeJobModal} style={btnSecondary}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save Job'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Job Roles manager ─────────────────────────────────────────────────────────

function JobRolesList({ showToast }) {
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newRole, setNewRole] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('job_roles').select('*').order('name');
    if (error) showToast(error.message, 'error');
    else setRoles(data || []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    const name = newRole.trim();
    if (!name) return;
    setSaving(true);
    const { error } = await supabase.from('job_roles').insert([{ name }]);
    if (error) showToast(error.message, 'error');
    else { showToast(`"${name}" added`, 'success'); setNewRole(''); load(); }
    setSaving(false);
  };

  const handleDelete = async (r) => {
    if (!window.confirm(`Remove role "${r.name}"?`)) return;
    const { error } = await supabase.from('job_roles').delete().eq('id', r.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Role removed', 'success'); load(); }
  };

  return (
    <div>
      <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 6 }}>Job Roles</div>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16 }}>
        These are the available roles across all clients. Add as many as needed — they appear as selectable options when creating a job or rate card.
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, maxWidth: 420 }}>
        <input
          style={{ ...inputStyle, flex: 1 }}
          placeholder="e.g. Pipe Layer, Boilermaker…"
          value={newRole}
          onChange={e => setNewRole(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
        />
        <button onClick={handleAdd} disabled={saving || !newRole.trim()} style={btnPrimary}>
          {saving ? '…' : '+ Add'}
        </button>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 32 }}><Spinner /></div>
      ) : roles.length === 0 ? (
        <EmptyState message="No job roles yet." />
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {roles.map(r => (
            <div key={r.id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: C.card, border: `1px solid ${C.border}`,
              borderRadius: 8, padding: '7px 12px',
            }}>
              <span style={{ fontSize: 13, color: C.text, fontWeight: 500 }}>{r.name}</span>
              <button
                onClick={() => handleDelete(r)}
                style={{ background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}
                title="Remove role"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
