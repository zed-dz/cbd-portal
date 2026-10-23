import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { fmtDateTime } from '../../utils/dates';
import { logActivity } from '../../utils/activity';
import { Spinner, EmptyState, Modal, Field, Badge } from '../../components';
import { openPrintWindow } from '../../components/timesheet/TimesheetDetailView';
import { buildSignedCopyHtml } from '../../utils/signatures';
import { KNOWN_FIELDS, placeholdersIn, labelFor, pickTemplate, knownValues, fillTemplate } from '../../utils/contracts';
import { COMPANY_NAME, loadTemplates, prepareContract, saveContract, notifyContract } from '../../utils/contractSend';

// Contracts (2026-10-23), money admins only. Templates with {{placeholders}} on one
// tab; every contract sent to a worker on the other. Sending fills the template from
// the worker record, asks only for what the portal cannot know, and the worker reads
// and signs in the app. Signed contracts are frozen by the database.

const TYPES = ['full-time', 'part-time', 'casual', 'subcontractor'];
const STATUS_COLOR = { needs_details: 'yellow', sent: 'blue', viewed: 'purple', signed: 'green', withdrawn: 'gray' };
const STATUS_LABEL = { needs_details: 'Needs details', sent: 'Sent', viewed: 'Opened', signed: 'Signed', withdrawn: 'Withdrawn' };
const blankTpl = () => ({ id: null, name: '', worker_type: 'casual', body: '', is_default: false, notes: '', version: 1 });

export function ContractsPage({ showToast, currentWorker, openSendFor }) {
  const [tab, setTab] = useState('contracts');
  const [templates, setTemplates] = useState([]);
  const [contracts, setContracts] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tplForm, setTplForm] = useState(null);
  const [sendForm, setSendForm] = useState(null);   // { worker, template, typed, existingId }
  const [viewing, setViewing] = useState(null);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, { data: c, error: e2 }, { data: w }] = await Promise.all([
        loadTemplates(),
        supabase.from('worker_contracts').select('*').order('created_at', { ascending: false }),
        supabase.from('workers').select('id, name, email, mobile, address, job_title, worker_type, role, date_of_birth, subcontractor_abn, pay_rate_a, pay_rate_regular, casual_loading_pct, emergency_name, emergency_phone, app_status').is('archived_at', null).order('name'),
      ]);
      if (e2) throw e2;
      setTemplates(t); setContracts(c || []); setWorkers((w || []).filter(x => x.role !== 'admin'));
    } catch (e) { showToast(e.message, 'error'); }
    setLoading(false);
  }, [showToast]);
  useEffect(() => { load(); }, [load]);

  // Opened from the Add Worker form when specifics are missing.
  useEffect(() => {
    if (!openSendFor || !workers.length || !templates.length) return;
    const w = workers.find(x => x.id === openSendFor.workerId);
    const t = templates.find(x => x.id === openSendFor.templateId) || pickTemplate(templates, w?.worker_type);
    if (w && t) setSendForm({ worker: w, template: t, typed: {}, existingId: openSendFor.contractId || null });
  }, [openSendFor, workers, templates]);

  const byWorker = useMemo(() => Object.fromEntries(workers.map(w => [w.id, w])), [workers]);

  // ── templates ──
  const saveTemplate = async () => {
    const f = tplForm;
    if (!f.name.trim()) { showToast('Give the template a name.', 'error'); return; }
    if (!f.body.trim()) { showToast('The contract text is empty.', 'error'); return; }
    setBusy(true);
    const payload = { name: f.name.trim(), worker_type: f.worker_type || null, body: f.body, is_default: !!f.is_default, notes: f.notes?.trim() || null, created_by: currentWorker?.name || null };
    let error;
    if (f.id) {
      if (f.bump) payload.version = (f.version || 1) + 1;
      if (payload.is_default) await supabase.from('contract_templates').update({ is_default: false }).eq('is_default', true).is('archived_at', null).filter('worker_type', f.worker_type ? 'eq' : 'is', f.worker_type || null).neq('id', f.id);
      ({ error } = await supabase.from('contract_templates').update(payload).eq('id', f.id));
    } else {
      if (payload.is_default) await supabase.from('contract_templates').update({ is_default: false }).eq('is_default', true).is('archived_at', null).filter('worker_type', f.worker_type ? 'eq' : 'is', f.worker_type || null);
      ({ error } = await supabase.from('contract_templates').insert([payload]));
    }
    setBusy(false);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: f.id ? (f.bump ? 'new version' : 'updated') : 'created', object_type: 'contract_template', object_id: f.id, after: { name: payload.name } });
    showToast('Template saved.'); setTplForm(null); load();
  };
  const archiveTemplate = async (t, archive) => {
    const { error } = await supabase.from('contract_templates').update({ archived_at: archive ? new Date().toISOString() : null, is_default: archive ? false : t.is_default }).eq('id', t.id);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: archive ? 'archived' : 'restored', object_type: 'contract_template', object_id: t.id, after: { name: t.name } }); load();
  };

  // ── sending ──
  const preview = useMemo(() => {
    if (!sendForm || !sendForm.worker || !sendForm.template) return null;
    const values = { ...knownValues(sendForm.worker, currentWorker, { name: COMPANY_NAME }), ...sendForm.typed };
    const f = fillTemplate(sendForm.template.body, values);
    const custom = placeholdersIn(sendForm.template.body).filter(k => !(k in knownValues({}, null)) || f.missing.includes(k));
    return { ...f, toType: custom };
  }, [sendForm, currentWorker]);
  const doSend = async () => {
    if (preview.missing.length) { showToast(`Still missing: ${preview.missing.map(labelFor).join(', ')}`, 'error'); return; }
    setBusy(true);
    try {
      const row = prepareContract({ worker: sendForm.worker, template: sendForm.template, sender: currentWorker, typed: sendForm.typed });
      await saveContract(row, sendForm.worker, { existingId: sendForm.existingId });
      showToast(`Contract sent to ${sendForm.worker.name}. They got a text and an email.`); setSendForm(null); load();
    } catch (e) { showToast(e.message, 'error'); }
    setBusy(false);
  };
  const remind = async (c) => {
    const w = byWorker[c.worker_id]; if (!w) return;
    await notifyContract(w);
    await supabase.from('worker_contracts').update({ reminded_at: new Date().toISOString() }).eq('id', c.id);
    logActivity({ verb: 'reminded', object_type: 'worker_contract', object_id: c.id, after: { name: `${c.title} → ${w.name}` } });
    showToast(`Reminder sent to ${w.name}.`); load();
  };
  const withdraw = async (c) => {
    const reason = window.prompt('Why is it withdrawn? (kept in the log)'); if (reason === null) return;
    const { error } = await supabase.from('worker_contracts').update({ status: 'withdrawn', withdrawn_reason: reason.slice(0, 200) }).eq('id', c.id);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: 'withdrawn', object_type: 'worker_contract', object_id: c.id, after: { name: c.title, reason } }); load();
  };
  const printSigned = (c) => {
    const w = byWorker[c.worker_id];
    openPrintWindow(buildSignedCopyHtml({ kind: 'Employment contract', title: c.title, context: `${c.template_name_snapshot} v${c.template_version}`, text: c.body, currentVersion: c.template_version, signedVersion: c.template_version,
      workerName: w?.name || '', signedName: c.signed_name, signedAt: fmtDateTime(c.signed_at), ip: c.ip, userAgent: c.user_agent, signaturePng: c.signature_png, brand: COMPANY_NAME, printedAt: fmtDateTime(new Date().toISOString()), snapshot: c.body, snapshotSha256: c.content_sha256 }));
  };

  if (loading) return <Spinner />;
  const needle = q.trim().toLowerCase();
  const shown = contracts.filter(c => (filter === 'all' || c.status === filter) && (!needle || `${byWorker[c.worker_id]?.name || ''} ${c.title}`.toLowerCase().includes(needle)))
    .sort((a, b) => (a.status === 'needs_details' ? -1 : 0) - (b.status === 'needs_details' ? -1 : 0));
  const counts = contracts.reduce((m, c) => ({ ...m, [c.status]: (m[c.status] || 0) + 1 }), {});
  const tabBtn = (id, label) => <button key={id} onClick={() => setTab(id)} style={{ ...btnSecondary, minHeight: 36, padding: '6px 14px', background: tab === id ? C.accentSoft : 'transparent', borderColor: tab === id ? C.accentBorder : C.border, color: tab === id ? C.accent : C.text }}>{label}</button>;

  return (
    <div data-area="contracts">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, color: C.text, fontSize: 20, fontWeight: 800 }}>📝 Contracts</h2>
          <div style={{ color: C.textMuted, fontSize: 12.5, marginTop: 2 }}>Templates fill themselves from the worker record. You type only what the portal cannot know. The worker signs in the app.</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>{tabBtn('contracts', `Sent contracts${counts.needs_details ? ` · ${counts.needs_details} need details` : ''}`)}{tabBtn('templates', `Templates (${templates.filter(t => !t.archived_at).length})`)}</div>
      </div>

      {tab === 'templates' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}><button onClick={() => setTplForm(blankTpl())} style={{ ...btnPrimary, minHeight: 40 }}>+ New template</button></div>
          <div style={{ display: 'grid', gap: 8 }}>
            {templates.map(t => (
              <div key={t.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', opacity: t.archived_at ? 0.6 : 1, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>{t.name} <span style={{ color: C.textDim, fontSize: 12, fontWeight: 500 }}>v{t.version}</span></div>
                  <div style={{ color: C.textMuted, fontSize: 12.5, marginTop: 2 }}>{t.worker_type || 'any type'}{t.is_default ? ' · default' : ''} · {placeholdersIn(t.body).length} placeholders{t.notes ? ` · ${t.notes}` : ''}</div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {t.is_default && <Badge label="Default" color="orange" size="sm" />}{t.archived_at && <Badge label="Archived" color="gray" size="sm" />}
                  {!t.archived_at && <button onClick={() => setTplForm({ ...t, notes: t.notes || '', bump: false })} style={{ ...btnSmall, minHeight: 36 }}>Edit</button>}
                  {t.archived_at ? <button onClick={() => archiveTemplate(t, false)} style={{ ...btnSmall, minHeight: 36 }}>Restore</button> : <button onClick={() => archiveTemplate(t, true)} style={{ ...btnSmall, minHeight: 36, color: '#fca5a5' }}>Archive</button>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'contracts' && (
        <div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search worker or contract" aria-label="Search contracts" style={{ ...inputStyle, marginBottom: 0, flex: '1 1 220px', maxWidth: 360 }} />
            {['all', 'needs_details', 'sent', 'viewed', 'signed', 'withdrawn'].map(s => (
              <button key={s} onClick={() => setFilter(s)} style={{ ...btnSecondary, minHeight: 36, padding: '6px 10px', fontSize: 12.5, background: filter === s ? C.accentSoft : 'transparent', borderColor: filter === s ? C.accentBorder : C.border, color: filter === s ? C.accent : C.text }}>
                {s === 'all' ? `All (${contracts.length})` : `${STATUS_LABEL[s]} (${counts[s] || 0})`}
              </button>
            ))}
            <button onClick={() => setSendForm({ worker: null, template: null, typed: {}, existingId: null })} style={{ ...btnPrimary, minHeight: 40, marginLeft: 'auto' }}>+ Send a contract</button>
          </div>
          {!shown.length ? <EmptyState icon="📝" message="No contracts here yet. Press + Send a contract, or add a worker: their contract is prepared by itself." /> : (
            <div style={{ display: 'grid', gap: 8 }}>
              {shown.map(c => { const w = byWorker[c.worker_id]; return (
                <div key={c.id} data-area="contract row" style={{ background: C.card, border: `1px solid ${c.status === 'needs_details' ? 'rgba(234,179,8,0.45)' : C.border}`, borderRadius: 10, padding: '12px 14px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>{w?.name || 'Worker'} <span style={{ color: C.textDim, fontSize: 12, fontWeight: 500 }}>· {w?.worker_type || ''}</span></div>
                    <div style={{ color: C.textMuted, fontSize: 12.5, marginTop: 2 }}>{c.title} v{c.template_version}{c.sent_at ? ` · sent ${fmtDateTime(c.sent_at)} by ${c.sent_by_name || 'office'}` : ''}{c.viewed_at ? ` · opened ${fmtDateTime(c.viewed_at)}` : ''}{c.signed_at ? ` · signed ${fmtDateTime(c.signed_at)}` : ''}</div>
                    {c.status === 'needs_details' && <div style={{ color: '#fde68a', fontSize: 12.5, marginTop: 3 }}>Type: {c.missing.map(labelFor).join(', ')}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <Badge label={STATUS_LABEL[c.status]} color={STATUS_COLOR[c.status]} size="sm" />
                    <button onClick={() => setViewing(c)} style={{ ...btnSmall, minHeight: 36 }}>View</button>
                    {c.status === 'needs_details' && w && <button onClick={() => setSendForm({ worker: w, template: templates.find(t => t.id === c.template_id) || pickTemplate(templates, w.worker_type), typed: c.fields || {}, existingId: c.id })} style={{ ...btnPrimary, minHeight: 36, padding: '6px 12px' }}>Finish & send</button>}
                    {['sent', 'viewed'].includes(c.status) && <button onClick={() => remind(c)} style={{ ...btnSmall, minHeight: 36 }}>Remind</button>}
                    {['needs_details', 'sent', 'viewed'].includes(c.status) && <button onClick={() => withdraw(c)} style={{ ...btnSmall, minHeight: 36, color: '#fca5a5' }}>Withdraw</button>}
                    {c.status === 'signed' && <button onClick={() => printSigned(c)} style={{ ...btnSmall, minHeight: 36 }}>🖨 Signed copy</button>}
                  </div>
                </div>
              ); })}
            </div>
          )}
        </div>
      )}

      {tplForm && (
        <Modal title={tplForm.id ? 'Edit template' : 'New template'} onClose={() => !busy && setTplForm(null)} width={760}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }} className="contracts-two">
            <Field label="Name"><input value={tplForm.name} onChange={e => setTplForm(f => ({ ...f, name: e.target.value }))} style={inputStyle} maxLength={120} /></Field>
            <Field label="For worker type">
              <select value={tplForm.worker_type || ''} onChange={e => setTplForm(f => ({ ...f, worker_type: e.target.value }))} style={inputStyle}>
                <option value="">Any type</option>{TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Contract text" hint="Write {{placeholder}} wherever a detail goes. Known ones fill themselves; any other word becomes a detail the office types when sending.">
            <textarea value={tplForm.body} onChange={e => setTplForm(f => ({ ...f, body: e.target.value }))} rows={14} style={{ ...inputStyle, fontFamily: 'inherit', lineHeight: 1.5, resize: 'vertical' }} />
          </Field>
          <details style={{ marginBottom: 12, color: C.textMuted, fontSize: 12.5 }}>
            <summary style={{ cursor: 'pointer', color: C.text }}>Placeholders the portal fills by itself</summary>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 4, marginTop: 8 }}>
              {KNOWN_FIELDS.map(([k, l]) => <div key={k}><code style={{ color: C.accent }}>{`{{${k}}}`}</code> <span>{l}</span></div>)}
            </div>
            <div style={{ marginTop: 8 }}>In this template, the office will type: <b style={{ color: C.text }}>{placeholdersIn(tplForm.body).filter(k => !KNOWN_FIELDS.some(([kk]) => kk === k)).map(labelFor).join(', ') || 'nothing'}</b></div>
          </details>
          <Field label="Note (optional)"><input value={tplForm.notes} onChange={e => setTplForm(f => ({ ...f, notes: e.target.value }))} style={inputStyle} maxLength={400} /></Field>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.text, fontSize: 13.5, marginBottom: 8, minHeight: 36, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!tplForm.is_default} onChange={e => setTplForm(f => ({ ...f, is_default: e.target.checked }))} /> Default for this worker type (used by the automatic send)
          </label>
          {tplForm.id && <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.text, fontSize: 13.5, marginBottom: 14, minHeight: 36, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!tplForm.bump} onChange={e => setTplForm(f => ({ ...f, bump: e.target.checked }))} /> This is a new version (v{(tplForm.version || 1) + 1}). Contracts already sent keep their old wording.
          </label>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button onClick={() => setTplForm(null)} disabled={busy} style={btnSecondary}>Cancel</button>
            <button onClick={saveTemplate} disabled={busy} style={btnPrimary}>{busy ? 'Saving…' : 'Save template'}</button>
          </div>
        </Modal>
      )}

      {sendForm && (
        <Modal title={sendForm.existingId ? 'Finish and send' : 'Send a contract'} onClose={() => !busy && setSendForm(null)} width={820}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }} className="contracts-two">
            <Field label="Worker">
              <select value={sendForm.worker?.id || ''} onChange={e => { const w = workers.find(x => x.id === e.target.value); setSendForm(f => ({ ...f, worker: w, template: w ? (pickTemplate(templates, w.worker_type) || f.template) : f.template })); }} style={inputStyle}>
                <option value="">Pick a worker…</option>{workers.map(w => <option key={w.id} value={w.id}>{w.name} · {w.worker_type || '?'}</option>)}
              </select>
            </Field>
            <Field label="Template">
              <select value={sendForm.template?.id || ''} onChange={e => setSendForm(f => ({ ...f, template: templates.find(t => t.id === e.target.value) }))} style={inputStyle}>
                <option value="">Pick a template…</option>{templates.filter(t => !t.archived_at).map(t => <option key={t.id} value={t.id}>{t.name} ({t.worker_type || 'any'}) v{t.version}</option>)}
              </select>
            </Field>
          </div>
          {sendForm.worker && sendForm.template && preview && (
            <>
              {preview.toType.length > 0 && (
                <div style={{ background: C.warningSoft, border: '1px solid rgba(234,179,8,0.35)', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
                  <div style={{ color: '#fde68a', fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Type these details. Everything else is filled from {sendForm.worker.name}'s record.</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
                    {preview.toType.map(k => (
                      <Field key={k} label={labelFor(k)}>
                        <input value={sendForm.typed[k] || ''} onChange={e => setSendForm(f => ({ ...f, typed: { ...f.typed, [k]: e.target.value } }))} style={inputStyle} />
                      </Field>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ color: C.textMuted, fontSize: 12, marginBottom: 4 }}>Preview, exactly as {sendForm.worker.name} will read it. Placeholders still in curly braces are missing.</div>
              <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14, color: C.text, fontSize: 13.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: '38vh', overflowY: 'auto', marginBottom: 14 }}>{preview.text}</div>
            </>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button onClick={() => setSendForm(null)} disabled={busy} style={btnSecondary}>Cancel</button>
            <button onClick={doSend} disabled={busy || !sendForm.worker || !sendForm.template || !preview || preview.missing.length > 0} style={btnPrimary}>{busy ? 'Sending…' : 'Send to worker'}</button>
          </div>
        </Modal>
      )}

      {viewing && (
        <Modal title={viewing.title} onClose={() => setViewing(null)} width={760} dismissible>
          <div style={{ color: C.textDim, fontSize: 12, marginBottom: 8 }}>{byWorker[viewing.worker_id]?.name} · {STATUS_LABEL[viewing.status]}{viewing.signed_at ? ` · signed as "${viewing.signed_name}" ${fmtDateTime(viewing.signed_at)}${viewing.ip ? ` · ${viewing.ip}` : ''}` : ''}</div>
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14, color: C.text, fontSize: 13.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', maxHeight: '55vh', overflowY: 'auto' }}>{viewing.body}</div>
          {viewing.signature_png && <img src={viewing.signature_png} alt="Signature" style={{ marginTop: 10, maxWidth: 320, background: '#fff', borderRadius: 6, padding: 6 }} />}
        </Modal>
      )}
      <style>{`@media (max-width: 640px) { .contracts-two { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}
