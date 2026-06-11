import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnDanger, btnSmall } from '../../theme';
import { todayISO } from '../../utils/dates';
import { downloadCSV } from '../../utils/csv';
import { useDraft, DraftBanner } from '../../utils/useDraft';
import { Spinner, Modal, Field, TableWrap, Th, Td, EmptyState } from '../../components';
import { EmailHistoryPanel } from '../../components/inbox/EmailHistoryPanel';

const clientDefaults = {
  name: '', site: '', contact: '', contact_email: '', contact_phone: '',
  rate_a: '', rate_b: '', rate_c: '',
  charge_travel: '', charge_meal: '', notes: '',
  email_domains: [],
};

const rateCardDefaults = {
  role_name: '', uom: 'hour', category: '',
  rate_a: '', rate_b: '', rate_c: '',
  notes: '', sort_order: 0,
};

const jobDefaults = {
  name: '', description: '', site: '', address: '',
  site_contact_name: '', site_contact_email: '', site_contact_phone: '',
  start_date: '', end_date: '', status: 'active',
  required_roles: [], notes: '',
};

// Schedule-of-Rates building blocks. Mirror the CBD printed SOR layout.
const UOM_OPTIONS = [
  { value: 'hour',  label: 'Hour' },
  { value: 'shift', label: 'Shift' },
  { value: 'day',   label: 'Day' },
  { value: 'ton',   label: 'Ton' },
  { value: 'unit',  label: 'Unit' },
  { value: 'each',  label: 'Each' },
  { value: 'km',    label: 'km' },
  { value: 'm3',    label: 'm³' },
  { value: 'm2',    label: 'm²' },
  { value: 'lm',    label: 'Lineal m' },
];

const CATEGORY_OPTIONS = [
  { value: 'labour',      label: 'Labour' },
  { value: 'plant',       label: 'Plant & Machinery' },
  { value: 'attachments', label: 'Plant Attachments' },
  { value: 'materials',   label: 'Materials & Tipping' },
  { value: 'allowances',  label: 'Allowances' },
  { value: 'other',       label: 'Other' },
];

const CATEGORY_LABEL = Object.fromEntries(CATEGORY_OPTIONS.map(c => [c.value, c.label]));

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
        {[{ id: 'clients', label: 'Clients' }, { id: 'job_roles', label: 'Common Roles' }].map(t => (
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
      email_domains: Array.isArray(c.email_domains) ? c.email_domains : [],
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
      rate_b: n(form.rate_b),
      rate_c: n(form.rate_c),
      // Keep legacy columns in sync for payroll calc backward compat.
      rate_regular:  A,
      rate_overtime: n(form.rate_b),
      rate_night:    n(form.rate_b),
      rate_weekend:  n(form.rate_c),
      charge_travel: n(form.charge_travel), charge_meal: n(form.charge_meal),
      notes: form.notes,
      email_domains: (form.email_domains || [])
        .map(d => (d || '').toLowerCase().trim().replace(/^@/, ''))
        .filter(Boolean),
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
              <Th>Default A · B · C</Th><Th>Rates</Th><Th>Projects</Th><Th>Actions</Th>
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
                    title="Schedule of rates — line items"
                  >
                    Rates {c.client_rate_cards?.length > 0 ? `(${c.client_rate_cards.length})` : ''}
                  </button>
                </Td>
                <Td>
                  <button
                    onClick={() => setJobsClient({ ...c, _initialTab: 'jobs' })}
                    style={{ ...btnSmall, background: 'rgba(249,115,22,0.12)', color: C.accent, border: 'none' }}
                  >
                    Projects {c.client_jobs?.length > 0 ? `(${c.client_jobs.length})` : ''}
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

            <div style={{ gridColumn: '1 / -1' }}>
              <Field
                label="Email Domains"
                hint="Any email from these domains will be tagged to this client in the Inbox. Add the company domain (e.g. sydneywater.com.au) so new contacts at this client show up automatically. Skip personal domains like gmail.com."
              >
                <DomainsInput
                  value={form.email_domains}
                  onChange={(arr) => setForm(f => ({ ...f, email_domains: arr }))}
                />
              </Field>
            </div>

            <div style={{ gridColumn: '1 / -1', marginTop: 4 }}>
              <div style={{ background: 'rgba(249,115,22,0.06)', border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.accent, letterSpacing: 1, marginBottom: 8 }}>
                  💵 DEFAULT CLIENT RATES ($/hr)
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  <Field label="A — Normal (Mon–Fri ≤8h)">
                    <input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_a}
                      onChange={e => setForm(f => ({ ...f, rate_a: e.target.value }))}
                      placeholder="e.g. 68.00" />
                  </Field>
                  <Field label="B — OT 1.5× (night/Sat day)">
                    <input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_b}
                      onChange={e => setForm(f => ({ ...f, rate_b: e.target.value }))}
                      placeholder="e.g. 95.00" />
                  </Field>
                  <Field label="C — OT 2× (Sun/PH/Sat >8h)">
                    <input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_c}
                      onChange={e => setForm(f => ({ ...f, rate_c: e.target.value }))}
                      placeholder="e.g. 120.00" />
                  </Field>
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
                  Catch-all defaults. Add a full Schedule of Rates (per line item, with UOM) under <strong>Rates</strong> on the client row to override.
                </div>
              </div>
            </div>

            <Field label="Travel Charge ($)"><input style={inputStyle} type="number" step="0.01" min="0" value={form.charge_travel} onChange={e => setForm(f => ({ ...f, charge_travel: e.target.value }))} /></Field>
            <Field label="Meal Charge ($)"><input style={inputStyle} type="number" step="0.01" min="0" value={form.charge_meal} onChange={e => setForm(f => ({ ...f, charge_meal: e.target.value }))} /></Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Notes"><textarea style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></Field>
            </div>
          </div>
          {modal !== 'add' && (
            <div style={{ marginTop: 14 }}>
              <EmailHistoryPanel
                clientId={modal.id}
                onOpenInbox={(threadId) => {
                  if (threadId) window.sessionStorage.setItem('inbox_focus_thread', threadId);
                  window.dispatchEvent(new CustomEvent('cbd:navigate', { detail: { page: 'inbox' } }));
                }}
              />
            </div>
          )}

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
          { id: 'jobs', label: '📋 Projects' },
          { id: 'rates', label: '💰 Schedule of Rates' },
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

// Schedule of Rates panel — line items grouped by category, mirrors the
// CBD printed SOR layout. Each line item carries description / UOM /
// A / B / C / category / notes. B and C are optional (single-rate items
// like Materials use only A; "All shifts" attachments use only A too).
function RatesPanel({ client, showToast }) {
  const [cards, setCards] = useState([]);
  const [allRoles, setAllRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | 'add' | cardObj
  const [bulkOpen, setBulkOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
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
      supabase.from('client_rate_cards').select('*').eq('client_id', client.id)
        .order('category', { ascending: true, nullsFirst: false })
        .order('sort_order', { ascending: true })
        .order('role_name',  { ascending: true }),
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
      role_name: card.role_name,
      uom:       card.uom      || 'hour',
      category:  card.category || '',
      rate_a:    card.rate_a ?? '',
      rate_b:    card.rate_b ?? '',
      rate_c:    card.rate_c ?? '',
      notes:     card.notes || '',
      sort_order: card.sort_order || 0,
    });
  };
  const close = () => { draft.clear(); setEditing(null); };

  const handleSave = async () => {
    if (!form.role_name.trim()) { showToast('Description is required.', 'error'); return; }
    if (form.rate_a === '') { showToast('Rate A is required.', 'error'); return; }
    setSaving(true);
    const n = v => v === '' ? null : parseFloat(v);
    const payload = {
      client_id:  client.id,
      role_name:  form.role_name.trim(),
      uom:        form.uom || 'hour',
      category:   form.category || null,
      rate_a:     n(form.rate_a),
      rate_b:     n(form.rate_b),
      rate_c:     n(form.rate_c),
      notes:      form.notes || null,
      sort_order: parseInt(form.sort_order, 10) || 0,
    };
    if (editing === 'add') {
      const { error } = await supabase.from('client_rate_cards').insert([payload]);
      if (error) showToast(error.message, 'error');
      else { showToast('Line item added', 'success'); close(); load(); }
    } else {
      const { error } = await supabase.from('client_rate_cards').update(payload).eq('id', editing.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Line item updated', 'success'); close(); load(); }
    }
    setSaving(false);
  };

  const handleDelete = async (card) => {
    if (!window.confirm(`Remove "${card.role_name}"?`)) return;
    const { error } = await supabase.from('client_rate_cards').delete().eq('id', card.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Line item removed', 'success'); load(); }
  };

  // Group cards by category for display. Uncategorised items get an
  // "Uncategorised" bucket and render last.
  const grouped = (() => {
    const buckets = new Map();
    for (const cat of CATEGORY_OPTIONS) buckets.set(cat.value, []);
    buckets.set('_uncategorised', []);
    cards.forEach(c => {
      const k = c.category || '_uncategorised';
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(c);
    });
    return [...buckets.entries()].filter(([, list]) => list.length > 0);
  })();

  return (
    <div>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>
        Each line item carries its own A / B / C rate. If a description has no row here, the client's default rates above apply. <strong>Use "Upload rates"</strong> to paste a full Schedule of Rates from a PDF or Excel.
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14, gap: 8, flexWrap: 'wrap' }}>
        <button onClick={() => setUploadOpen(true)} style={btnSecondary} disabled={!!editing || bulkOpen || uploadOpen}>📤 Upload rates</button>
        <button onClick={() => setBulkOpen(true)} style={btnSecondary} disabled={!!editing || bulkOpen || uploadOpen}>+ Add many</button>
        <button onClick={openAdd} style={btnPrimary} disabled={!!editing || bulkOpen || uploadOpen}>+ Add line item</button>
      </div>

      {bulkOpen && (
        <BulkRateAdd
          client={client}
          allRoles={allRoles}
          onCancel={() => setBulkOpen(false)}
          onSaved={() => { setBulkOpen(false); load(); }}
          showToast={showToast}
        />
      )}

      {uploadOpen && (
        <UploadRatesModal
          client={client}
          onClose={() => setUploadOpen(false)}
          onSaved={() => { setUploadOpen(false); load(); }}
          showToast={showToast}
        />
      )}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 28 }}><Spinner /></div>
      ) : cards.length === 0 && !editing && !bulkOpen ? (
        <EmptyState message="No line items yet. Use the client's default rates above, or add a per-item Schedule of Rates." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {grouped.map(([catKey, list]) => {
            const label = catKey === '_uncategorised' ? 'Uncategorised' : CATEGORY_LABEL[catKey] || catKey;
            return (
              <div key={catKey}>
                <div style={{
                  fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: 1.5,
                  fontFamily: '"DM Mono", monospace', textTransform: 'uppercase',
                  marginBottom: 6, paddingLeft: 2,
                }}>
                  {label} <span style={{ opacity: 0.6 }}>· {list.length}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {list.map(c => (
                    <div key={c.id} style={{
                      background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
                      padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                    }}>
                      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text }}>
                          {c.role_name}
                          <span style={{
                            marginLeft: 8, fontSize: 10, color: C.textMuted, fontFamily: '"DM Mono", monospace',
                            background: C.cardHover, padding: '1px 6px', borderRadius: 4,
                          }}>{(c.uom || 'hour').toUpperCase()}</span>
                        </div>
                        {c.notes && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{c.notes}</div>}
                      </div>
                      <div style={{ display: 'flex', gap: 12, fontFamily: '"DM Mono", monospace', fontSize: 13 }}>
                        <RateChip label="A" value={c.rate_a} />
                        <RateChip label="B" value={c.rate_b} />
                        <RateChip label="C" value={c.rate_c} />
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => openEdit(c)} style={btnSmall} disabled={!!editing}>Edit</button>
                        <button onClick={() => handleDelete(c)} style={btnDanger}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <div style={{ marginTop: 18, background: C.card, border: `1px solid ${C.accent}`, borderRadius: 10, padding: 18 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 12 }}>
            {editing === 'add' ? 'New line item' : `Edit: ${editing.role_name}`}
          </div>
          <DraftBanner
            visible={draft.draftRestored}
            onDiscard={() => { draft.discardDraft(); setForm(rateCardDefaults); }}
            onDismiss={draft.dismissBanner}
            label="Unsaved draft restored."
          />
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
            <Field label="Description">
              <>
                <input style={inputStyle} list={`roles-list-${client.id}-edit`}
                  value={form.role_name}
                  onChange={e => setForm(f => ({ ...f, role_name: e.target.value }))}
                  placeholder="e.g. General Labour · 8T Excavator · VENM" />
                <datalist id={`roles-list-${client.id}-edit`}>
                  {allRoles.map(r => <option key={r.id} value={r.name} />)}
                </datalist>
              </>
            </Field>
            <Field label="UOM">
              <select style={inputStyle} value={form.uom} onChange={e => setForm(f => ({ ...f, uom: e.target.value }))}>
                {UOM_OPTIONS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
              </select>
            </Field>
            <Field label="Category">
              <select style={inputStyle} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                <option value="">— uncategorised —</option>
                {CATEGORY_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="A — Normal" hint="Required.">
              <input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_a}
                onChange={e => setForm(f => ({ ...f, rate_a: e.target.value }))}
                placeholder="e.g. 60.15" />
            </Field>
            <Field label="B — OT 1.5×" hint="Leave blank if single-rate item.">
              <input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_b}
                onChange={e => setForm(f => ({ ...f, rate_b: e.target.value }))} placeholder="e.g. 85.05" />
            </Field>
            <Field label="C — OT 2×" hint="Leave blank if single-rate item.">
              <input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_c}
                onChange={e => setForm(f => ({ ...f, rate_c: e.target.value }))} placeholder="e.g. 103.50" />
            </Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Notes"><input style={inputStyle} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="e.g. T&D rates · Wet weather inclusive" /></Field>
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

function RateChip({ label, value }) {
  const has = value != null && value !== '';
  return (
    <span title={label}>
      <span style={{ color: C.textMuted, fontSize: 10 }}>{label} </span>
      {has
        ? <strong style={{ color: C.accent }}>${parseFloat(value).toFixed(2)}</strong>
        : <span style={{ color: C.textDim }}>—</span>}
    </span>
  );
}

// Bulk add: a tabular form for entering many line items at once. Mirrors the
// way a Schedule of Rates is normally built (row-by-row from a PDF / spreadsheet).
function BulkRateAdd({ client, allRoles, onCancel, onSaved, showToast }) {
  const emptyRow = () => ({
    role_name: '', uom: 'hour', category: '',
    rate_a: '', rate_b: '', rate_c: '', notes: '',
  });
  const [rows, setRows] = useState([emptyRow(), emptyRow(), emptyRow()]);
  const [saving, setSaving] = useState(false);

  const updateRow = (i, patch) => setRows(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const addRow    = () => setRows(rs => [...rs, emptyRow()]);
  const removeRow = (i) => setRows(rs => rs.filter((_, idx) => idx !== i));

  const handleSaveAll = async () => {
    const n = v => v === '' ? null : parseFloat(v);
    const payload = rows
      .filter(r => r.role_name.trim() && r.rate_a !== '')
      .map((r, idx) => ({
        client_id:  client.id,
        role_name:  r.role_name.trim(),
        uom:        r.uom || 'hour',
        category:   r.category || null,
        rate_a:     n(r.rate_a),
        rate_b:     n(r.rate_b),
        rate_c:     n(r.rate_c),
        notes:      r.notes || null,
        sort_order: idx,
      }));
    if (!payload.length) {
      showToast('Fill at least one row with a description and Rate A.', 'error');
      return;
    }
    setSaving(true);
    const { error } = await supabase.from('client_rate_cards').insert(payload);
    setSaving(false);
    if (error) { showToast(error.message, 'error'); return; }
    showToast(`${payload.length} line item${payload.length === 1 ? '' : 's'} added`, 'success');
    onSaved();
  };

  return (
    <div style={{
      marginBottom: 18, background: C.card, border: `1px solid ${C.accent}`, borderRadius: 10, padding: 18,
    }}>
      <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 4 }}>
        Add many line items
      </div>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>
        Type or pick a description, set UOM + Category, fill in A (and optionally B / C). Empty rows are skipped on save.
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 760 }}>
          <thead>
            <tr style={{ color: C.textMuted, textAlign: 'left' }}>
              <th style={{ padding: '4px 6px', fontWeight: 600, fontFamily: '"DM Mono", monospace', fontSize: 10, letterSpacing: 1 }}>CATEGORY</th>
              <th style={{ padding: '4px 6px', fontWeight: 600, fontFamily: '"DM Mono", monospace', fontSize: 10, letterSpacing: 1 }}>DESCRIPTION</th>
              <th style={{ padding: '4px 6px', fontWeight: 600, fontFamily: '"DM Mono", monospace', fontSize: 10, letterSpacing: 1 }}>UOM</th>
              <th style={{ padding: '4px 6px', fontWeight: 600, fontFamily: '"DM Mono", monospace', fontSize: 10, letterSpacing: 1, textAlign: 'right' }}>A</th>
              <th style={{ padding: '4px 6px', fontWeight: 600, fontFamily: '"DM Mono", monospace', fontSize: 10, letterSpacing: 1, textAlign: 'right' }}>B</th>
              <th style={{ padding: '4px 6px', fontWeight: 600, fontFamily: '"DM Mono", monospace', fontSize: 10, letterSpacing: 1, textAlign: 'right' }}>C</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td style={{ padding: '4px 4px' }}>
                  <select
                    style={{ ...inputStyle, padding: '6px 8px', minWidth: 110 }}
                    value={r.category}
                    onChange={e => updateRow(i, { category: e.target.value })}
                  >
                    <option value="">—</option>
                    {CATEGORY_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </td>
                <td style={{ padding: '4px 4px' }}>
                  <input
                    style={{ ...inputStyle, padding: '6px 8px', minWidth: 180 }}
                    list={`roles-list-${client.id}-bulk`}
                    value={r.role_name}
                    onChange={e => updateRow(i, { role_name: e.target.value })}
                    placeholder="e.g. General Labour"
                  />
                </td>
                <td style={{ padding: '4px 4px' }}>
                  <select
                    style={{ ...inputStyle, padding: '6px 8px', minWidth: 80 }}
                    value={r.uom}
                    onChange={e => updateRow(i, { uom: e.target.value })}
                  >
                    {UOM_OPTIONS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                  </select>
                </td>
                <td style={{ padding: '4px 4px' }}>
                  <input
                    style={{ ...inputStyle, padding: '6px 8px', width: 80, textAlign: 'right' }}
                    type="number" step="0.01" min="0"
                    value={r.rate_a}
                    onChange={e => updateRow(i, { rate_a: e.target.value })}
                  />
                </td>
                <td style={{ padding: '4px 4px' }}>
                  <input
                    style={{ ...inputStyle, padding: '6px 8px', width: 80, textAlign: 'right' }}
                    type="number" step="0.01" min="0"
                    value={r.rate_b}
                    onChange={e => updateRow(i, { rate_b: e.target.value })}
                  />
                </td>
                <td style={{ padding: '4px 4px' }}>
                  <input
                    style={{ ...inputStyle, padding: '6px 8px', width: 80, textAlign: 'right' }}
                    type="number" step="0.01" min="0"
                    value={r.rate_c}
                    onChange={e => updateRow(i, { rate_c: e.target.value })}
                  />
                </td>
                <td style={{ padding: '4px 4px', textAlign: 'right' }}>
                  <button
                    onClick={() => removeRow(i)}
                    style={{ ...btnSmall, padding: '4px 8px', background: 'transparent', border: 'none', color: C.textMuted }}
                    title="Remove row"
                    disabled={rows.length === 1}
                  >×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <datalist id={`roles-list-${client.id}-bulk`}>
        {allRoles.map(r => <option key={r.id} value={r.name} />)}
      </datalist>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, gap: 10 }}>
        <button onClick={addRow} style={btnSmall}>+ Add row</button>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onCancel} style={btnSecondary}>Cancel</button>
          <button onClick={handleSaveAll} disabled={saving} style={btnPrimary}>
            {saving ? 'Saving…' : 'Save all'}
          </button>
        </div>
      </div>
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
      address: j.address || '',
      site_contact_name:  j.site_contact_name  || '',
      site_contact_email: j.site_contact_email || '',
      site_contact_phone: j.site_contact_phone || '',
      start_date: j.start_date || '',
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
    if (!form.name.trim()) { showToast('Project name is required.', 'error'); return; }
    setSaving(true);
    const payload = {
      ...form,
      client_id: client.id,
      start_date: form.start_date || null,
      end_date:   form.end_date   || null,
      site_contact_name:  form.site_contact_name  || null,
      site_contact_email: form.site_contact_email || null,
      site_contact_phone: form.site_contact_phone || null,
    };
    if (modal === 'add') {
      const { error } = await supabase.from('client_jobs').insert([payload]);
      if (error) showToast(error.message, 'error');
      else { showToast('Project added', 'success'); closeJobModal(); load(); }
    } else {
      const { error } = await supabase.from('client_jobs').update(payload).eq('id', modal.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Project updated', 'success'); closeJobModal(); load(); }
    }
    setSaving(false);
  };

  const handleDelete = async (j) => {
    if (!window.confirm(`Delete project "${j.name}"?`)) return;
    const { error } = await supabase.from('client_jobs').delete().eq('id', j.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Project deleted', 'success'); load(); }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
        <button onClick={openAdd} style={btnPrimary}>+ Add Project</button>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 28 }}><Spinner /></div>
      ) : jobs.length === 0 ? (
        <EmptyState message="No projects yet for this client. Add the first one." />
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
                  {(j.site_contact_name || j.site_contact_email || j.site_contact_phone) && (
                    <div style={{ marginTop: 6, display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: C.textMuted }}>
                      {j.site_contact_name  && <span>👤 {j.site_contact_name}</span>}
                      {j.site_contact_phone && <span>📞 {j.site_contact_phone}</span>}
                      {j.site_contact_email && <span>✉️ {j.site_contact_email}</span>}
                    </div>
                  )}
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
            {modal === 'add' ? 'New Project' : `Edit: ${modal.name}`}
          </div>
          <DraftBanner
            visible={draft.draftRestored}
            onDiscard={() => { draft.discardDraft(); setForm(jobDefaults); }}
            onDismiss={draft.dismissBanner}
            label="Unsaved project draft restored."
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Project Name *"><input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Rail Corridor Maintenance – Eastern Line" /></Field>
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

            {/* Site contact for this specific project — each project can have
                its own person on the ground. */}
            <div style={{ gridColumn: '1 / -1', marginTop: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.accent, letterSpacing: 1, marginBottom: 4 }}>
                👤 SITE CONTACT (PROJECT-SPECIFIC)
              </div>
            </div>
            <Field label="Site Contact Name"><input style={inputStyle} value={form.site_contact_name} onChange={e => setForm(f => ({ ...f, site_contact_name: e.target.value }))} placeholder="e.g. John Smith" /></Field>
            <Field label="Phone"><input style={inputStyle} type="tel" value={form.site_contact_phone} onChange={e => setForm(f => ({ ...f, site_contact_phone: e.target.value }))} placeholder="04xx xxx xxx" /></Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Email"><input style={inputStyle} type="email" value={form.site_contact_email} onChange={e => setForm(f => ({ ...f, site_contact_email: e.target.value }))} placeholder="john@client.com.au" /></Field>
            </div>
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
            <button onClick={handleSave} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save Project'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Upload Rates: paste a Schedule of Rates from PDF / Excel / CSV ───────────

// Normalise a user-typed UOM to one of our canonical values. Accepts plain
// English ("Hour", "Hr", "ea"), the symbols m²/m³, and common typos.
function normaliseUom(raw) {
  const s = (raw || '').toString().trim().toLowerCase().replace(/[\s.]/g, '');
  if (!s) return 'hour';
  const map = {
    hour: 'hour', hr: 'hour', hrs: 'hour', hours: 'hour', h: 'hour',
    shift: 'shift', shifts: 'shift', sh: 'shift',
    day: 'day', days: 'day', d: 'day',
    ton: 'ton', tonne: 'ton', tonnes: 'ton', t: 'ton', mt: 'ton',
    unit: 'unit', units: 'unit', u: 'unit',
    each: 'each', ea: 'each',
    km: 'km', kilometre: 'km', kilometer: 'km',
    m3: 'm3', 'm³': 'm3', cubicmetre: 'm3', cubicmeter: 'm3',
    m2: 'm2', 'm²': 'm2', squaremetre: 'm2', squaremeter: 'm2',
    lm: 'lm', linealmetre: 'lm', linealmeter: 'lm', linealm: 'lm', linearmetre: 'lm',
  };
  return map[s] || 'hour';
}

// Normalise a category string. Accepts the exact PDF section headers
// ("LABOUR", "PLANT & MACHINERY – WET HIRE", "MATERIALS & TIPPING") and
// returns a canonical value or null.
function normaliseCategory(raw) {
  const s = (raw || '').toString().toLowerCase();
  if (!s.trim()) return null;
  if (s.includes('labour') || s.includes('labor')) return 'labour';
  if (s.includes('attach') || s.includes('hammer')) return 'attachments';
  if (s.includes('plant') || s.includes('machinery') || s.includes('hire')) return 'plant';
  if (s.includes('material') || s.includes('tipping')) return 'materials';
  if (s.includes('allowance') || s.includes('travel') || s.includes('lafha') || s.includes('meal')) return 'allowances';
  if (s === 'other') return 'other';
  return null;
}

// Parse a price like "$ 60.15", "60.15", "$60.15", "1,407.60", "POR" → number or null.
function parsePrice(raw) {
  if (raw == null) return null;
  const s = raw.toString().trim();
  if (!s) return null;
  if (/^(POR|POA|TBA|N\/A)$/i.test(s)) return null;
  const cleaned = s.replace(/[$,\s]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// Auto-detect delimiter (comma vs tab vs pipe) by counting candidate chars on
// the first non-empty line. Tabs win when present — that's what you get when
// pasting from Excel / PDF tables.
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/).find(l => l.trim()) || '';
  if (firstLine.includes('\t')) return '\t';
  if (firstLine.includes('|'))  return '|';
  return ',';
}

// Minimal CSV-ish line splitter that respects double-quoted fields containing
// the delimiter. Sufficient for human-entered SOR data.
function splitLine(line, delim) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === delim && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// Header detection: known synonyms → canonical column key. Returns either a
// map { columnIndex: canonicalKey } when the first row looks like headers,
// or null when the parser should fall back to positional defaults.
function detectHeaders(firstRow) {
  // `row_number` is a synthetic canonical for CBD's "Item" / "#" column — it
  // gets mapped but ignored in get(), so the actual Description column wins.
  const synonyms = {
    row_number:  ['#','no','no.','item','item no','item number','number','row','line no'],
    category:    ['category','section','group','type'],
    description: ['description','desc','name','role','line item','line'],
    uom:         ['uom','unit','units','um','u m'],
    rate_a:      ['a','rate a','rate_a','normal','mon-fri','monfri','col a','column a'],
    rate_b:      ['b','rate b','rate_b','ot','ot 1.5','overtime','sat','col b','column b','>8 hrs','night'],
    rate_c:      ['c','rate c','rate_c','ot 2','sun','ph','public holiday','col c','column c'],
    notes:       ['notes','note','comment','remark','basis'],
  };
  const norm = s => (s || '').toString().toLowerCase().replace(/[\s_·\-+/().]+/g, ' ').replace(/\s+/g,' ').trim();
  const headers = firstRow.map(norm);
  let matches = 0;
  const result = {};
  headers.forEach((h, idx) => {
    for (const [canon, syns] of Object.entries(synonyms)) {
      // Short synonyms (≤2 chars like "a","b","c","no") must match exactly,
      // otherwise "Labour".includes("a") wrongly tags a category cell as rate_a.
      const matched = syns.some(s => s.length <= 2 ? h === s : (h === s || h.includes(s)));
      if (matched) {
        result[idx] = canon;
        matches++;
        break;
      }
    }
  });
  // Need at least 2 header matches to trust this as a header row.
  return matches >= 2 ? result : null;
}

function parseSorText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], skipped: [] };
  const delim = detectDelimiter(text);
  const allCells = lines.map(l => splitLine(l, delim));
  const headerMap = detectHeaders(allCells[0]);

  // Positional fallback: when there's no recognisable header row, assume
  // (category, description, uom, rate_a, rate_b, rate_c, notes). The user
  // can override by including a header.
  const positional = ['category','description','uom','rate_a','rate_b','rate_c','notes'];

  const rows = [];
  const skipped = [];
  const dataStart = headerMap ? 1 : 0;

  // If the first data column looks like a row number ("1", "2", "12") and
  // there's no explicit "#" header, strip it from each row so columns line up.
  const looksNumbered = !headerMap && allCells.slice(dataStart, dataStart + 3).every(r => /^\d+$/.test((r[0] || '').trim()));

  for (let i = dataStart; i < allCells.length; i++) {
    let cells = allCells[i].slice();
    if (looksNumbered) cells.shift();

    const get = (key) => {
      if (headerMap) {
        const idx = Object.entries(headerMap).find(([, v]) => v === key)?.[0];
        return idx != null ? cells[idx] : '';
      }
      const idx = positional.indexOf(key);
      return idx >= 0 ? cells[idx] : '';
    };

    const description = (get('description') || '').trim();
    if (!description) { skipped.push({ line: i + 1, reason: 'no description', raw: allCells[i].join(delim) }); continue; }

    const rate_a = parsePrice(get('rate_a'));
    const rate_b = parsePrice(get('rate_b'));
    const rate_c = parsePrice(get('rate_c'));

    if (rate_a == null && rate_b == null && rate_c == null) {
      skipped.push({ line: i + 1, reason: 'no rates', raw: allCells[i].join(delim) });
      continue;
    }

    rows.push({
      category:   normaliseCategory(get('category')),
      description,
      uom:        normaliseUom(get('uom')),
      rate_a, rate_b, rate_c,
      notes:      (get('notes') || '').trim() || null,
    });
  }
  return { rows, skipped };
}

function UploadRatesModal({ client, onClose, onSaved, showToast }) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState({ rows: [], skipped: [] });
  const [saving, setSaving] = useState(false);
  const [replace, setReplace] = useState(false);

  useEffect(() => { setParsed(parseSorText(text)); }, [text]);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setText(content);
  };

  const handleSave = async () => {
    if (!parsed.rows.length) { showToast('Nothing to save.', 'error'); return; }
    if (replace && !window.confirm(`Replace ALL existing line items for ${client.name} with the ${parsed.rows.length} parsed rows? This cannot be undone.`)) return;
    setSaving(true);
    const payload = parsed.rows.map((r, idx) => ({
      client_id:  client.id,
      role_name:  r.description,
      uom:        r.uom,
      category:   r.category,
      rate_a:     r.rate_a,
      rate_b:     r.rate_b,
      rate_c:     r.rate_c,
      notes:      r.notes,
      sort_order: idx,
    }));
    // Insert FIRST, then delete the old rows. If the insert fails the user
    // still has their original data; we never strand them with an empty list.
    const { data: inserted, error } = await supabase.from('client_rate_cards').insert(payload).select('id');
    if (error) { setSaving(false); showToast(error.message, 'error'); return; }
    if (replace && inserted?.length) {
      const newIds = inserted.map(r => r.id);
      const { error: dErr } = await supabase
        .from('client_rate_cards')
        .delete()
        .eq('client_id', client.id)
        .not('id', 'in', `(${newIds.join(',')})`);
      if (dErr) { setSaving(false); showToast(`Uploaded but failed to clear old rows: ${dErr.message}`, 'error'); return; }
    }
    setSaving(false);
    showToast(`${payload.length} line item${payload.length === 1 ? '' : 's'} uploaded`, 'success');
    onSaved();
  };

  return (
    <Modal title="📤 Upload Schedule of Rates" onClose={onClose} width={780}>
      <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 14, lineHeight: 1.55 }}>
        Paste rows from Excel or a PDF table, or upload a CSV. Format is auto-detected.
        Each row should have a <strong>description</strong> and at least one rate.
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ ...btnSecondary, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          📁 Choose CSV file
          <input type="file" accept=".csv,.tsv,.txt" style={{ display: 'none' }} onChange={onFile} />
        </label>
        <span style={{ fontSize: 12, color: C.textDim }}>— or paste below —</span>
      </div>

      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        spellCheck={false}
        placeholder={`Examples (any of these formats work):\n\nCategory,Description,UOM,Rate A,Rate B,Rate C,Notes\nlabour,General Labour,hour,60.15,85.05,103.50,\nlabour,Skilled Labourer,hour,73.05,95.00,110.25,\nplant,8T Excavator,hour,121.80,167.35,178.75,\nmaterials,VENM,ton,28.85,,,T&D rates\n\n— OR — paste tab-separated cells straight from Excel.`}
        style={{
          ...inputStyle, minHeight: 200, resize: 'vertical',
          fontFamily: '"DM Mono", monospace', fontSize: 12, lineHeight: 1.5,
        }}
      />

      {/* Preview */}
      {(parsed.rows.length > 0 || parsed.skipped.length > 0) && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 12 }}>
            <span style={{ color: C.success }}>✓ {parsed.rows.length} valid</span>
            {parsed.skipped.length > 0 && (
              <span style={{ color: C.warning }}>⚠ {parsed.skipped.length} skipped (no description or no rates)</span>
            )}
          </div>

          {parsed.rows.length > 0 && (
            <div style={{ maxHeight: 260, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead style={{ position: 'sticky', top: 0, background: C.card }}>
                  <tr style={{ color: C.textMuted, textAlign: 'left' }}>
                    <th style={{ padding: '6px 10px', fontFamily: '"DM Mono", monospace', fontSize: 10, letterSpacing: 1 }}>CAT</th>
                    <th style={{ padding: '6px 10px', fontFamily: '"DM Mono", monospace', fontSize: 10, letterSpacing: 1 }}>DESCRIPTION</th>
                    <th style={{ padding: '6px 10px', fontFamily: '"DM Mono", monospace', fontSize: 10, letterSpacing: 1 }}>UOM</th>
                    <th style={{ padding: '6px 10px', fontFamily: '"DM Mono", monospace', fontSize: 10, letterSpacing: 1, textAlign: 'right' }}>A</th>
                    <th style={{ padding: '6px 10px', fontFamily: '"DM Mono", monospace', fontSize: 10, letterSpacing: 1, textAlign: 'right' }}>B</th>
                    <th style={{ padding: '6px 10px', fontFamily: '"DM Mono", monospace', fontSize: 10, letterSpacing: 1, textAlign: 'right' }}>C</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.map((r, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td style={{ padding: '4px 10px', color: C.textDim, fontFamily: '"DM Mono", monospace', fontSize: 10 }}>
                        {(r.category || '—').toUpperCase()}
                      </td>
                      <td style={{ padding: '4px 10px', color: C.text }}>{r.description}</td>
                      <td style={{ padding: '4px 10px', color: C.textMuted, fontFamily: '"DM Mono", monospace', fontSize: 10 }}>{r.uom.toUpperCase()}</td>
                      <td style={{ padding: '4px 10px', textAlign: 'right', color: C.accent, fontFamily: '"DM Mono", monospace' }}>
                        {r.rate_a != null ? `$${r.rate_a.toFixed(2)}` : <span style={{ color: C.textDim }}>—</span>}
                      </td>
                      <td style={{ padding: '4px 10px', textAlign: 'right', color: C.accent, fontFamily: '"DM Mono", monospace' }}>
                        {r.rate_b != null ? `$${r.rate_b.toFixed(2)}` : <span style={{ color: C.textDim }}>—</span>}
                      </td>
                      <td style={{ padding: '4px 10px', textAlign: 'right', color: C.accent, fontFamily: '"DM Mono", monospace' }}>
                        {r.rate_c != null ? `$${r.rate_c.toFixed(2)}` : <span style={{ color: C.textDim }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {parsed.skipped.length > 0 && (
            <details style={{ marginTop: 8, fontSize: 11, color: C.textMuted }}>
              <summary style={{ cursor: 'pointer' }}>{parsed.skipped.length} skipped row(s) — click to expand</summary>
              <ul style={{ marginTop: 6, paddingLeft: 18, fontFamily: '"DM Mono", monospace' }}>
                {parsed.skipped.slice(0, 20).map((s, i) => (
                  <li key={i}>line {s.line}: {s.reason} <span style={{ opacity: 0.6 }}>· {s.raw.slice(0, 60)}</span></li>
                ))}
              </ul>
            </details>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.textMuted, marginTop: 10 }}>
            <input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} />
            Replace this client's existing line items first (clean slate)
          </label>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
        <button onClick={onClose} style={btnSecondary}>Cancel</button>
        <button
          onClick={handleSave}
          disabled={saving || !parsed.rows.length}
          style={btnPrimary}
        >
          {saving ? 'Saving…' : `Save ${parsed.rows.length || ''} line items`}
        </button>
      </div>
    </Modal>
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

// ── Domains chip input (email_domains for a client) ────────────────────────

function DomainsInput({ value = [], onChange }) {
  const [text, setText] = useState('');

  const add = () => {
    const d = text.trim().toLowerCase().replace(/^@/, '');
    if (!d) return;
    if ((value || []).includes(d)) { setText(''); return; }
    onChange([...(value || []), d]);
    setText('');
  };

  const remove = (d) => onChange((value || []).filter(x => x !== d));

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 8px',
      }}>
        <span style={{ color: C.textDim, fontSize: 13, fontFamily: '"DM Mono", monospace' }}>@</span>
        <input
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: C.text, fontSize: 13, padding: '4px 0' }}
          placeholder="sydneywater.com.au"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); add(); }
            else if (e.key === 'Backspace' && !text && value.length) remove(value[value.length - 1]);
          }}
        />
        <button type="button" onClick={add} disabled={!text.trim()} style={btnSmall}>Add</button>
      </div>
      {(value || []).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {value.map(d => (
            <span key={d} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              background: C.cardHover, border: `1px solid ${C.border}`, borderRadius: 999,
              padding: '3px 9px', fontSize: 12, color: C.text, fontFamily: '"DM Mono", monospace',
            }}>
              @{d}
              <button type="button" onClick={() => remove(d)} style={{ background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
