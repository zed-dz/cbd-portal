import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { Field, Spinner, EmptyState } from '../../components';

const SMS_DISABLED_HINT = 'SMS needs a paid provider (Twilio ≈ $0.01/msg). Email is the free path — wired below.';

function fmtSentAt(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' });
}

export function BulkMessagesPage({ showToast }) {
  const [tab, setTab] = useState('compose');
  const [workerSubject, setWorkerSubject] = useState('');
  const [workerMsg, setWorkerMsg] = useState('');
  const [clientSubject, setClientSubject] = useState('');
  const [clientMsg, setClientMsg] = useState('');
  const [workers, setWorkers] = useState([]);
  const [clients, setClients] = useState([]);
  const [selectedWorkers, setSelectedWorkers] = useState([]);
  const [selectedClients, setSelectedClients] = useState([]);
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySearch, setHistorySearch] = useState('');

  useEffect(() => {
    (async () => {
      const [w, c] = await Promise.all([
        supabase.from('workers').select('id, name, mobile, email').eq('app_status', 'Active').is('archived_at', null).order('name'),
        supabase.from('clients').select('id, name, contact, contact_email, contact_phone').order('name'),
      ]);
      setWorkers(w.data || []);
      setClients(c.data || []);
    })();
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    const { data, error } = await supabase
      .from('message_log')
      .select('*')
      .order('sent_at', { ascending: false })
      .limit(500);
    if (error) showToast(error.message, 'error');
    else setHistory(data || []);
    setHistoryLoading(false);
  }, [showToast]);

  useEffect(() => { if (tab === 'history') loadHistory(); }, [tab, loadHistory]);

  const toggleWorker = (id) => setSelectedWorkers(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const toggleClient = (id) => setSelectedClients(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const allWorkers = workers.length > 0 && selectedWorkers.length === workers.length;
  const allClients = clients.length > 0 && selectedClients.length === clients.length;

  // Which recipient emails have already been contacted recently — used to
  // mark them in the list so admin doesn't double-send the same message.
  const recentlyEmailed = (() => {
    const m = new Map();
    for (const row of history) {
      if (!row.recipient_email) continue;
      const prev = m.get(row.recipient_email);
      if (!prev || new Date(row.sent_at) > new Date(prev.sent_at)) m.set(row.recipient_email, row);
    }
    return m;
  })();

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
        id: r.id,
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
      const { data: { user } } = await supabase.auth.getUser();
      const { data, error } = await supabase.functions.invoke('send-bulk-email', {
        body: { recipients, subject, body, audience, sent_by: user?.id || null },
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
          // Refresh history (whether the user is currently on that tab or not).
          loadHistory();
        }
      }
    } catch (e) {
      showToast(e.message || 'Send failed.', 'error');
    }
    setSending(false);
  }

  // Group history rows by batch_id so the same blast collapses into one card.
  const groupedHistory = (() => {
    const search = historySearch.toLowerCase();
    const filtered = history.filter(r =>
      !search ||
      (r.recipient_email || '').toLowerCase().includes(search) ||
      (r.recipient_name  || '').toLowerCase().includes(search) ||
      (r.subject         || '').toLowerCase().includes(search) ||
      (r.body            || '').toLowerCase().includes(search)
    );
    const m = new Map();
    for (const row of filtered) {
      const k = row.batch_id;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(row);
    }
    return [...m.entries()]
      .map(([batch_id, rows]) => ({ batch_id, rows, sent_at: rows[0].sent_at, subject: rows[0].subject, body: rows[0].body, audience: rows[0].audience }))
      .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));
  })();

  const panelStyle = { background: C.card, borderRadius: R.lg, border: `1px solid ${C.border}`, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 };

  const recipientStats = (pool, selectedIds, emailKey) => {
    const selected = selectedIds.map(id => pool.find(p => p.id === id)).filter(Boolean);
    const withEmail = selected.filter(r => r[emailKey]).length;
    const noEmail = selected.length - withEmail;
    return { withEmail, noEmail };
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 2, borderBottom: `1px solid ${C.border}`, marginBottom: 18 }}>
        {[
          { id: 'compose', label: '✉️ Compose' },
          { id: 'history', label: '📜 Sent History' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: 'none', border: 'none',
            borderBottom: tab === t.id ? `2px solid ${C.accent}` : '2px solid transparent',
            color: tab === t.id ? C.text : C.textMuted, padding: '8px 16px', cursor: 'pointer',
            fontSize: 13, fontWeight: tab === t.id ? 600 : 400, marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'compose' && (
        <>
          <div style={{
            background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.22)',
            borderRadius: R.lg, padding: '10px 14px', marginBottom: 16,
            fontSize: 12.5, color: C.textMuted, display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ fontSize: 16 }}>ⓘ</span>
            <span>
              <strong style={{ color: C.text }}>Email is wired</strong> via Resend (3,000/month free).
              For two-way conversations with replies, connect Gmail under <strong>Inbox</strong>.
              SMS needs a paid provider like Twilio (~$0.01/msg).
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 20 }}>
            {/* Workers panel */}
            <div style={panelStyle}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>👷 Worker Messages</div>
                <span style={{ fontSize: 11, color: C.textDim, fontFamily: MONO }}>{workers.length} active</span>
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <label style={{ color: C.textMuted, fontSize: 12.5 }}>Recipients · {selectedWorkers.length} selected</label>
                  <button onClick={() => setSelectedWorkers(allWorkers ? [] : workers.map(w => w.id))} style={{ ...btnSecondary, padding: '3px 10px', fontSize: 12 }}>{allWorkers ? 'Deselect All' : 'Select All'}</button>
                </div>
                <div style={{ maxHeight: 220, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: R.md, background: C.bg }}>
                  {workers.map(w => {
                    const last = w.email ? recentlyEmailed.get(w.email) : null;
                    return (
                      <label key={w.id} style={{
                        display: 'flex', alignItems: 'center', gap: 9, padding: '8px 12px', cursor: 'pointer',
                        borderBottom: `1px solid ${C.border}`,
                        opacity: w.email ? 1 : 0.5,
                      }}>
                        <input type="checkbox" checked={selectedWorkers.includes(w.id)} onChange={() => toggleWorker(w.id)} />
                        <span style={{ color: C.text, fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
                        {last && (
                          <span title={`Last emailed ${new Date(last.sent_at).toLocaleString()} — "${last.subject || ''}"`} style={{
                            fontSize: 9.5, color: C.success, fontFamily: MONO,
                            background: 'rgba(34,197,94,0.10)', padding: '1px 6px', borderRadius: 999, letterSpacing: 0.3,
                          }}>✓ {fmtSentAt(last.sent_at)}</span>
                        )}
                        {w.email
                          ? <span style={{ color: C.textDim, fontSize: 10.5, fontFamily: MONO }}>{w.email.slice(0, 22)}{w.email.length > 22 ? '…' : ''}</span>
                          : <span style={{ color: '#fca5a5', fontSize: 10.5, fontFamily: MONO }}>no email</span>}
                      </label>
                    );
                  })}
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
                <button disabled title={SMS_DISABLED_HINT} style={{ ...btnSecondary, flex: 1, cursor: 'not-allowed' }}>
                  📱 SMS <span style={{ fontSize: 9, marginLeft: 4, padding: '1px 5px', borderRadius: 999, background: C.cardHover, color: C.textDim, fontFamily: MONO, letterSpacing: 0.5 }}>SOON</span>
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
                <span style={{ fontSize: 11, color: C.textDim, fontFamily: MONO }}>{clients.length} client{clients.length !== 1 ? 's' : ''}</span>
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <label style={{ color: C.textMuted, fontSize: 12.5 }}>Recipients · {selectedClients.length} selected</label>
                  <button onClick={() => setSelectedClients(allClients ? [] : clients.map(c => c.id))} style={{ ...btnSecondary, padding: '3px 10px', fontSize: 12 }}>{allClients ? 'Deselect All' : 'Select All'}</button>
                </div>
                <div style={{ maxHeight: 220, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: R.md, background: C.bg }}>
                  {clients.map(c => {
                    const last = c.contact_email ? recentlyEmailed.get(c.contact_email) : null;
                    return (
                      <label key={c.id} style={{
                        display: 'flex', alignItems: 'center', gap: 9, padding: '8px 12px', cursor: 'pointer',
                        borderBottom: `1px solid ${C.border}`,
                        opacity: c.contact_email ? 1 : 0.5,
                      }}>
                        <input type="checkbox" checked={selectedClients.includes(c.id)} onChange={() => toggleClient(c.id)} />
                        <span style={{ color: C.text, fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                        {last && (
                          <span title={`Last emailed ${new Date(last.sent_at).toLocaleString()} — "${last.subject || ''}"`} style={{
                            fontSize: 9.5, color: C.success, fontFamily: MONO,
                            background: 'rgba(34,197,94,0.10)', padding: '1px 6px', borderRadius: 999, letterSpacing: 0.3,
                          }}>✓ {fmtSentAt(last.sent_at)}</span>
                        )}
                        {c.contact_email
                          ? <span style={{ color: C.textDim, fontSize: 10.5, fontFamily: MONO }}>{c.contact_email.slice(0, 22)}{c.contact_email.length > 22 ? '…' : ''}</span>
                          : <span style={{ color: '#fca5a5', fontSize: 10.5, fontFamily: MONO }}>no email</span>}
                      </label>
                    );
                  })}
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
                <button disabled title={SMS_DISABLED_HINT} style={{ ...btnSecondary, flex: 1, cursor: 'not-allowed' }}>
                  📱 SMS <span style={{ fontSize: 9, marginLeft: 4, padding: '1px 5px', borderRadius: 999, background: C.cardHover, color: C.textDim, fontFamily: MONO, letterSpacing: 0.5 }}>SOON</span>
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
        </>
      )}

      {tab === 'history' && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center' }}>
            <input
              style={{ ...inputStyle, maxWidth: 320 }}
              placeholder="Search by recipient, subject…"
              value={historySearch}
              onChange={e => setHistorySearch(e.target.value)}
            />
            <button onClick={loadHistory} style={btnSmall}>↻ Refresh</button>
            <span style={{ fontSize: 11, color: C.textDim, marginLeft: 'auto', fontFamily: MONO }}>
              {history.length} message{history.length !== 1 ? 's' : ''} logged
            </span>
          </div>

          {historyLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>
          ) : groupedHistory.length === 0 ? (
            <EmptyState
              icon="📭"
              message="No emails sent yet. Compose a message and they'll appear here."
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {groupedHistory.map(batch => {
                const sent   = batch.rows.filter(r => r.status === 'sent').length;
                const failed = batch.rows.filter(r => r.status === 'failed').length;
                return (
                  <BatchCard key={batch.batch_id} batch={batch} sent={sent} failed={failed} />
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BatchCard({ batch, sent, failed }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`, borderRadius: R.lg, padding: 14,
    }}>
      <div onClick={() => setOpen(o => !o)} style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', cursor: 'pointer', gap: 10,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{batch.subject || '(no subject)'}</span>
            {batch.audience && (
              <span style={{ fontSize: 10, color: C.textMuted, fontFamily: MONO, padding: '1px 6px', background: C.cardHover, borderRadius: 999, letterSpacing: 0.5 }}>
                {batch.audience}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: C.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
            {(batch.body || '').slice(0, 220)}{(batch.body || '').length > 220 ? '…' : ''}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, fontSize: 11, fontFamily: MONO, color: C.textDim }}>
            <span>{new Date(batch.sent_at).toLocaleString('en-AU')}</span>
            <span style={{ color: C.success }}>✓ {sent} sent</span>
            {failed > 0 && <span style={{ color: '#fca5a5' }}>✗ {failed} failed</span>}
            <span style={{ marginLeft: 'auto', color: C.textMuted }}>{open ? '▴ hide recipients' : '▾ show recipients'}</span>
          </div>
        </div>
      </div>
      {open && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflowY: 'auto' }}>
            {batch.rows.map(r => (
              <div key={r.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 12, padding: '5px 8px', borderRadius: 5,
                background: r.status === 'failed' ? 'rgba(239,68,68,0.06)' : 'transparent',
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ color: C.text, fontWeight: 600 }}>{r.recipient_name || '—'}</span>
                  <span style={{ color: C.textDim, fontFamily: MONO, marginLeft: 8, fontSize: 11 }}>{r.recipient_email}</span>
                </div>
                <span style={{
                  fontSize: 10, fontFamily: MONO, padding: '1px 7px', borderRadius: 999,
                  background: r.status === 'sent' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                  color: r.status === 'sent' ? C.success : '#fca5a5',
                }}>
                  {r.status === 'sent' ? '✓ delivered' : '✗ failed'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
