import { useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, inputStyle, btnPrimary, btnSecondary } from '../../theme';
import { Field } from '../../components';

const SMS_DISABLED_HINT = 'SMS needs a paid provider (Twilio ≈ $0.01/msg). Email is the free path — wired below.';

export function BulkMessagesPage({ showToast }) {
  const [workerSubject, setWorkerSubject] = useState('');
  const [workerMsg, setWorkerMsg] = useState('');
  const [clientSubject, setClientSubject] = useState('');
  const [clientMsg, setClientMsg] = useState('');
  const [workers, setWorkers] = useState([]);
  const [clients, setClients] = useState([]);
  const [selectedWorkers, setSelectedWorkers] = useState([]);
  const [selectedClients, setSelectedClients] = useState([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    (async () => {
      const [w, c] = await Promise.all([
        supabase.from('workers').select('id, name, mobile, email').eq('app_status', 'Active').order('name'),
        supabase.from('clients').select('id, name, contact, contact_email, contact_phone').order('name'),
      ]);
      setWorkers(w.data || []);
      setClients(c.data || []);
    })();
  }, []);

  const toggleWorker = (id) => setSelectedWorkers(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const toggleClient = (id) => setSelectedClients(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const allWorkers = workers.length > 0 && selectedWorkers.length === workers.length;
  const allClients = clients.length > 0 && selectedClients.length === clients.length;

  async function sendEmail(audience) {
    const isWorkers = audience === 'workers';
    const subject = (isWorkers ? workerSubject : clientSubject).trim();
    const body    = (isWorkers ? workerMsg    : clientMsg).trim();
    const selectedIds = isWorkers ? selectedWorkers : selectedClients;

    if (!subject) { showToast('Enter a subject line.', 'error'); return; }
    if (!body)    { showToast('Enter a message.', 'error'); return; }
    if (!selectedIds.length) { showToast('Select at least one recipient.', 'error'); return; }

    const pool = isWorkers ? workers : clients;
    const recipients = selectedIds
      .map(id => pool.find(p => p.id === id))
      .filter(Boolean)
      .map(r => ({
        name:  r.name || (isWorkers ? '' : r.contact),
        email: isWorkers ? r.email : r.contact_email,
      }))
      .filter(r => r.email);

    if (!recipients.length) {
      showToast(`None of the selected ${audience} have an email on file.`, 'error');
      return;
    }

    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('send-bulk-email', {
        body: { recipients, subject, body, audience },
      });
      if (error || data?.error) {
        showToast(data?.firstError || data?.message || error?.message || 'Send failed.', 'error');
      } else {
        const skipped = recipients.length < selectedIds.length ? ` (${selectedIds.length - recipients.length} skipped — no email)` : '';
        const failed  = data.failed > 0 ? ` · ${data.failed} failed` : '';
        showToast(`Sent ${data.sent}/${data.total} emails${skipped}${failed}`, data.sent > 0 ? 'success' : 'error');
        if (data.sent > 0) {
          if (isWorkers) { setWorkerSubject(''); setWorkerMsg(''); setSelectedWorkers([]); }
          else           { setClientSubject(''); setClientMsg(''); setSelectedClients([]); }
        }
      }
    } catch (e) {
      showToast(e.message || 'Send failed.', 'error');
    }
    setSending(false);
  }

  const panelStyle = { background: C.card, borderRadius: R.lg, border: `1px solid ${C.border}`, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 };

  const recipientStats = (pool, selectedIds, emailKey) => {
    const selected = selectedIds.map(id => pool.find(p => p.id === id)).filter(Boolean);
    const withEmail = selected.filter(r => r[emailKey]).length;
    const noEmail = selected.length - withEmail;
    return { withEmail, noEmail };
  };

  return (
    <div>
      <div style={{
        background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.22)',
        borderRadius: R.lg, padding: '10px 14px', marginBottom: 16,
        fontSize: 12.5, color: C.textMuted, display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontSize: 16 }}>ⓘ</span>
        <span>
          <strong style={{ color: C.text }}>Email is wired and free</strong> via Resend (3,000/month).
          SMS is disabled — needs a paid provider like Twilio (~$0.01/msg) to add later.
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 20 }}>
        {/* Workers panel */}
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>👷 Worker Messages</div>
            <span style={{ fontSize: 11, color: C.textDim, fontFamily: '"DM Mono", monospace' }}>
              {workers.length} active
            </span>
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label style={{ color: C.textMuted, fontSize: 12.5 }}>Recipients · {selectedWorkers.length} selected</label>
              <button onClick={() => setSelectedWorkers(allWorkers ? [] : workers.map(w => w.id))} style={{ ...btnSecondary, padding: '3px 10px', fontSize: 12 }}>{allWorkers ? 'Deselect All' : 'Select All'}</button>
            </div>
            <div style={{ maxHeight: 180, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: R.md, background: C.bg }}>
              {workers.map(w => (
                <label key={w.id} style={{
                  display: 'flex', alignItems: 'center', gap: 9, padding: '8px 12px', cursor: 'pointer',
                  borderBottom: `1px solid ${C.border}`,
                  opacity: w.email ? 1 : 0.5,
                }}>
                  <input type="checkbox" checked={selectedWorkers.includes(w.id)} onChange={() => toggleWorker(w.id)} />
                  <span style={{ color: C.text, fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
                  {w.email
                    ? <span style={{ color: C.textDim, fontSize: 10.5, fontFamily: '"DM Mono", monospace' }}>{w.email.slice(0, 22)}{w.email.length > 22 ? '…' : ''}</span>
                    : <span style={{ color: '#fca5a5', fontSize: 10.5, fontFamily: '"DM Mono", monospace' }}>no email</span>}
                </label>
              ))}
              {workers.length === 0 && <div style={{ padding: 14, color: C.textMuted, fontSize: 13, textAlign: 'center' }}>No active workers.</div>}
            </div>
          </div>
          <Field label="Subject">
            <input style={inputStyle} value={workerSubject} onChange={e => setWorkerSubject(e.target.value)} placeholder="e.g. Tomorrow's shift update" />
          </Field>
          <Field label="Message">
            <textarea style={{ ...inputStyle, minHeight: 100, resize: 'vertical', fontFamily: 'inherit' }} value={workerMsg} onChange={e => setWorkerMsg(e.target.value)} placeholder="Type your message…" />
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              disabled
              title={SMS_DISABLED_HINT}
              style={{ ...btnSecondary, flex: 1, position: 'relative', cursor: 'not-allowed' }}
            >
              📱 SMS <span style={{ fontSize: 9, marginLeft: 4, padding: '1px 5px', borderRadius: 999, background: C.cardHover, color: C.textDim, fontFamily: '"DM Mono", monospace', letterSpacing: 0.5 }}>SOON</span>
            </button>
            <button onClick={() => sendEmail('workers')} disabled={sending} style={{ ...btnPrimary, flex: 1 }}>
              {sending ? 'Sending…' : '✉️ Send Email'}
            </button>
          </div>
          {selectedWorkers.length > 0 && (() => {
            const { withEmail, noEmail } = recipientStats(workers, selectedWorkers, 'email');
            return (
              <div style={{ fontSize: 11, color: C.textDim, marginTop: -4 }}>
                Will reach <strong style={{ color: C.text }}>{withEmail}</strong> via email{noEmail > 0 ? ` · skipping ${noEmail} without email` : ''}
              </div>
            );
          })()}
        </div>

        {/* Clients panel */}
        <div style={panelStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>🏗 Client Messages</div>
            <span style={{ fontSize: 11, color: C.textDim, fontFamily: '"DM Mono", monospace' }}>
              {clients.length} client{clients.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label style={{ color: C.textMuted, fontSize: 12.5 }}>Recipients · {selectedClients.length} selected</label>
              <button onClick={() => setSelectedClients(allClients ? [] : clients.map(c => c.id))} style={{ ...btnSecondary, padding: '3px 10px', fontSize: 12 }}>{allClients ? 'Deselect All' : 'Select All'}</button>
            </div>
            <div style={{ maxHeight: 180, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: R.md, background: C.bg }}>
              {clients.map(c => (
                <label key={c.id} style={{
                  display: 'flex', alignItems: 'center', gap: 9, padding: '8px 12px', cursor: 'pointer',
                  borderBottom: `1px solid ${C.border}`,
                  opacity: c.contact_email ? 1 : 0.5,
                }}>
                  <input type="checkbox" checked={selectedClients.includes(c.id)} onChange={() => toggleClient(c.id)} />
                  <span style={{ color: C.text, fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                  {c.contact_email
                    ? <span style={{ color: C.textDim, fontSize: 10.5, fontFamily: '"DM Mono", monospace' }}>{c.contact_email.slice(0, 22)}{c.contact_email.length > 22 ? '…' : ''}</span>
                    : <span style={{ color: '#fca5a5', fontSize: 10.5, fontFamily: '"DM Mono", monospace' }}>no email</span>}
                </label>
              ))}
              {clients.length === 0 && <div style={{ padding: 14, color: C.textMuted, fontSize: 13, textAlign: 'center' }}>No clients yet.</div>}
            </div>
          </div>
          <Field label="Subject">
            <input style={inputStyle} value={clientSubject} onChange={e => setClientSubject(e.target.value)} placeholder="e.g. Invoice attached" />
          </Field>
          <Field label="Message">
            <textarea style={{ ...inputStyle, minHeight: 100, resize: 'vertical', fontFamily: 'inherit' }} value={clientMsg} onChange={e => setClientMsg(e.target.value)} placeholder="Type your message…" />
          </Field>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              disabled
              title={SMS_DISABLED_HINT}
              style={{ ...btnSecondary, flex: 1, cursor: 'not-allowed' }}
            >
              📱 SMS <span style={{ fontSize: 9, marginLeft: 4, padding: '1px 5px', borderRadius: 999, background: C.cardHover, color: C.textDim, fontFamily: '"DM Mono", monospace', letterSpacing: 0.5 }}>SOON</span>
            </button>
            <button onClick={() => sendEmail('clients')} disabled={sending} style={{ ...btnPrimary, flex: 1 }}>
              {sending ? 'Sending…' : '✉️ Send Email'}
            </button>
          </div>
          {selectedClients.length > 0 && (() => {
            const { withEmail, noEmail } = recipientStats(clients, selectedClients, 'contact_email');
            return (
              <div style={{ fontSize: 11, color: C.textDim, marginTop: -4 }}>
                Will reach <strong style={{ color: C.text }}>{withEmail}</strong> via email{noEmail > 0 ? ` · skipping ${noEmail} without email` : ''}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
