import { useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary, btnSecondary } from '../../theme';
import { Modal, Field, Spinner } from '../index';

const TABS = [
  { id: 'workers', label: '👷 Workers',   sub: 'Active only' },
  { id: 'clients', label: '🏗 Clients',   sub: 'All clients' },
  { id: 'both',    label: '🌐 Everyone',  sub: 'Workers + clients' },
];

// `presetWorkers` lets a caller hand in an exact worker list instead of the
// whole active roster — the Workers page uses it to message just the crew who
// aren't on a job. When it's set the audience tabs are hidden, because the
// point is to message precisely that group.
export function SendBlastModal({ onClose, showToast, presetWorkers = null, presetLabel = '' }) {
  const preset = Array.isArray(presetWorkers);
  const [tab, setTab] = useState('workers');
  const [workers, setWorkers] = useState(preset ? presetWorkers : []);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(!preset);
  const [subject, setSubject] = useState('');
  const [body, setBody]       = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (preset) return;
    let mounted = true;
    (async () => {
      const [w, c] = await Promise.all([
        supabase.from('workers').select('id, name, email').eq('app_status', 'Active').is('archived_at', null).order('name'),
        supabase.from('clients').select('id, name, contact, contact_email').order('name'),
      ]);
      if (!mounted) return;
      setWorkers(w.data || []);
      setClients(c.data || []);
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [preset]);

  const buildRecipients = () => {
    const out = [];
    if (tab === 'workers' || tab === 'both') {
      workers.filter(w => w.email).forEach(w => out.push({ name: w.name, email: w.email }));
    }
    if (tab === 'clients' || tab === 'both') {
      clients.filter(c => c.contact_email).forEach(c => out.push({ name: c.contact || c.name, email: c.contact_email }));
    }
    return out;
  };

  const recipients = buildRecipients();
  const workersReached = workers.filter(w => w.email).length;
  const workersNoEmail = workers.length - workersReached;
  const clientsReached = clients.filter(c => c.contact_email).length;
  const clientsNoEmail = clients.length - clientsReached;

  const handleSend = async () => {
    if (!subject.trim()) { showToast('Subject is required.', 'error'); return; }
    if (!body.trim())    { showToast('Message body is required.', 'error'); return; }
    if (!recipients.length) { showToast('No recipients with email addresses.', 'error'); return; }

    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('send-bulk-email', {
        body: { recipients, subject: subject.trim(), body: body.trim(), audience: tab },
      });
      if (error || data?.error) {
        showToast(data?.firstError || data?.message || error?.message || 'Send failed.', 'error');
      } else {
        const failed = data.failed > 0 ? ` · ${data.failed} failed` : '';
        showToast(`Blast sent: ${data.sent}/${data.total}${failed}`, data.sent > 0 ? 'success' : 'error');
        if (data.sent > 0) onClose();
      }
    } catch (e) {
      showToast(e.message || 'Send failed.', 'error');
    }
    setSending(false);
  };

  return (
    <Modal title="📢 Send a Blast" onClose={onClose} width={560}>
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>
      ) : (
        <>
          {/* Audience picker — hidden when the caller fixed the recipient list */}
          {preset ? (
            <div style={{
              marginBottom: 18, background: C.cardHover, border: `1px solid ${C.borderStrong}`,
              borderRadius: R.md, padding: '10px 14px', fontSize: 13, color: C.text,
            }}>
              👷 {presetLabel || 'Selected workers'} — <strong>{workers.length}</strong> worker{workers.length !== 1 ? 's' : ''}
            </div>
          ) : (
          <div style={{
            display: 'flex', gap: 6, marginBottom: 18,
            background: C.bg, border: `1px solid ${C.border}`,
            borderRadius: R.md, padding: 4,
          }}>
            {TABS.map(t => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  style={{
                    flex: 1, padding: '8px 10px',
                    border: 'none', cursor: 'pointer',
                    background: active ? C.cardHover : 'transparent',
                    color: active ? C.text : C.textMuted,
                    borderRadius: R.sm, transition: 'all 120ms',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                    fontWeight: active ? 600 : 500, fontSize: 13,
                  }}
                >
                  <span>{t.label}</span>
                  <span style={{ fontSize: 10, color: C.textDim, fontFamily: MONO, letterSpacing: 0.5 }}>{t.sub}</span>
                </button>
              );
            })}
          </div>
          )}

          {/* Audience summary */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.22)',
            borderRadius: R.md, padding: '10px 14px', marginBottom: 16,
            fontSize: 12.5,
          }}>
            <span style={{ fontSize: 16 }}>📨</span>
            <span style={{ color: C.textMuted, lineHeight: 1.5 }}>
              Reaching <strong style={{ color: C.text }}>{recipients.length}</strong> recipient{recipients.length !== 1 ? 's' : ''} via email.
              {(tab === 'workers' || tab === 'both') && workersNoEmail > 0 && (
                <span style={{ color: '#fca5a5' }}> · {workersNoEmail} worker{workersNoEmail !== 1 ? 's' : ''} without email skipped</span>
              )}
              {(tab === 'clients' || tab === 'both') && clientsNoEmail > 0 && (
                <span style={{ color: '#fca5a5' }}> · {clientsNoEmail} client{clientsNoEmail !== 1 ? 's' : ''} without email skipped</span>
              )}
            </span>
          </div>

          <Field label="Subject *">
            <input style={inputStyle} value={subject} onChange={e => setSubject(e.target.value)} placeholder="e.g. Quick update for tomorrow" autoFocus />
          </Field>
          <Field label="Message *" hint="Plain text — line breaks are preserved in the email.">
            <textarea
              style={{ ...inputStyle, minHeight: 140, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
              value={body} onChange={e => setBody(e.target.value)}
              placeholder="Type your message…"
            />
          </Field>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 6 }}>
            <button onClick={onClose} style={btnSecondary}>Cancel</button>
            <button onClick={handleSend} disabled={sending || !recipients.length} style={btnPrimary}>
              {sending ? 'Sending…' : `📤 Send to ${recipients.length}`}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
