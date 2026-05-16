import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary, btnSecondary, btnDanger, btnSmall } from '../../theme';
import { Spinner, Modal, Field, EmptyState, TableWrap, Th, Td } from '../../components';
import { placeholderHints } from '../Inbox/inboxApi';

const empty = { name: '', subject: '', body: '' };

export function TemplatesPage({ showToast }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState(empty);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('email_templates')
      .select('*')
      .order('name');
    if (error) showToast(error.message, 'error');
    else setTemplates(data || []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm(empty); setModal('add'); };
  const openEdit = (t) => { setForm({ name: t.name, subject: t.subject, body: t.body }); setModal(t); };
  const close = () => { setModal(null); setForm(empty); };

  const save = async () => {
    if (!form.name.trim() || !form.subject.trim() || !form.body.trim()) {
      showToast('Name, subject and body are required.', 'error');
      return;
    }
    setSaving(true);
    const payload = { name: form.name.trim(), subject: form.subject.trim(), body: form.body, updated_at: new Date().toISOString() };
    const op = modal === 'add'
      ? supabase.from('email_templates').insert([payload])
      : supabase.from('email_templates').update(payload).eq('id', modal.id);
    const { error } = await op;
    if (error) showToast(error.message, 'error');
    else { showToast(modal === 'add' ? 'Template created' : 'Template updated', 'success'); close(); load(); }
    setSaving(false);
  };

  const remove = async (t) => {
    if (!window.confirm(`Delete template "${t.name}"?`)) return;
    const { error } = await supabase.from('email_templates').delete().eq('id', t.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Template deleted', 'success'); load(); }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <div>
          <h2 style={{ fontFamily: 'Syne, sans-serif', fontSize: 24, margin: 0, color: C.text, fontWeight: 700 }}>Email Templates</h2>
          <p style={{ margin: '4px 0 0 0', color: C.textMuted, fontSize: 13 }}>
            Reusable canned messages with <code style={{ color: C.accent, fontFamily: MONO, fontSize: 12 }}>{'{{placeholder}}'}</code> support. Used in Inbox compose and replies.
          </p>
        </div>
        <button onClick={openAdd} style={btnPrimary}>+ New Template</button>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner /></div>
      ) : templates.length === 0 ? (
        <EmptyState message="No templates yet. Create one and it'll appear in the Compose / Reply dropdown in Inbox." icon="📝" />
      ) : (
        <TableWrap>
          <thead>
            <tr><Th>Name</Th><Th>Subject</Th><Th>Preview</Th><Th align="right">Actions</Th></tr>
          </thead>
          <tbody>
            {templates.map(t => (
              <tr key={t.id}>
                <Td><strong style={{ color: C.text }}>{t.name}</strong></Td>
                <Td><span style={{ color: C.textMuted, fontSize: 12.5 }}>{t.subject}</span></Td>
                <Td>
                  <span style={{ color: C.textDim, fontSize: 12, fontFamily: MONO }}>
                    {(t.body || '').slice(0, 80)}{(t.body || '').length > 80 ? '…' : ''}
                  </span>
                </Td>
                <Td align="right">
                  <button onClick={() => openEdit(t)} style={btnSmall}>Edit</button>{' '}
                  <button onClick={() => remove(t)} style={btnDanger}>Delete</button>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      {modal && (
        <Modal title={modal === 'add' ? 'New Template' : `Edit: ${modal.name}`} onClose={close} width={620}>
          <Field label="Name *" hint="Shown in the dropdown — keep it short and clear.">
            <input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Timesheet approved" />
          </Field>
          <Field label="Subject *">
            <input style={inputStyle} value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} placeholder="Your timesheet for {{week_ending}} is approved" />
          </Field>
          <Field label="Body *" hint="Plain text only. Use placeholders to personalize.">
            <textarea
              style={{ ...inputStyle, minHeight: 200, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.55 }}
              value={form.body}
              onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
              placeholder="Hi {{worker_name}},..."
            />
          </Field>
          <PlaceholderRow />
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
            <button onClick={close} style={btnSecondary}>Cancel</button>
            <button onClick={save} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function PlaceholderRow() {
  return (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.md, padding: 10, marginTop: -4, marginBottom: 6 }}>
      <div style={{ fontSize: 10.5, color: C.textDim, fontFamily: MONO, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6, fontWeight: 700 }}>Available placeholders</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {placeholderHints().map(k => (
          <code key={k} style={{ background: C.cardHover, color: C.accent, border: `1px solid ${C.border}`, borderRadius: 4, padding: '2px 7px', fontFamily: MONO, fontSize: 11 }}>
            {`{{${k}}}`}
          </code>
        ))}
      </div>
    </div>
  );
}
