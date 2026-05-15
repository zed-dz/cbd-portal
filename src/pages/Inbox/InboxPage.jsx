import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { Spinner, EmptyState, Modal, Field } from '../../components';

function fmtAgo(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d`;
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' });
}

function fmtFull(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function initials(name) {
  if (!name) return '?';
  return name.split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
}

function avatarColor(email) {
  if (!email) return '#475569';
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) % 360;
  return `hsl(${h}, 45%, 38%)`;
}

export function InboxPage({ showToast }) {
  const [status, setStatus] = useState(null); // { configured, connected, email }
  const [statusLoading, setStatusLoading] = useState(true);
  const [threads, setThreads] = useState([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [filter, setFilter] = useState('all'); // 'all' | 'unread' | 'workers' | 'clients'
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);
  const messagesEndRef = useRef(null);

  // ── Status ──────────────────────────────────────────────────────────────

  const loadStatus = useCallback(async () => {
    try {
      const { data, error } = await supabase.functions.invoke('gmail-status', { method: 'GET' });
      if (error) { showToast(error.message, 'error'); return; }
      setStatus(data);
    } catch (e) {
      showToast(e.message || 'Failed to load Gmail status', 'error');
    } finally {
      setStatusLoading(false);
    }
  }, [showToast]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // ?gmail_connected=1 / gmail_error= from the OAuth redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('gmail_connected') === '1') {
      showToast('Gmail connected', 'success');
      window.history.replaceState({}, '', window.location.pathname);
      loadStatus();
    }
    const err = params.get('gmail_error');
    if (err) {
      showToast(`Gmail connection failed: ${err}`, 'error');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [loadStatus, showToast]);

  // ── Threads ─────────────────────────────────────────────────────────────

  const loadThreads = useCallback(async () => {
    setThreadsLoading(true);
    const { data, error } = await supabase
      .from('email_threads')
      .select('*, workers(id, name), clients(id, name)')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(200);
    if (error) showToast(error.message, 'error');
    else setThreads(data || []);
    setThreadsLoading(false);
  }, [showToast]);

  useEffect(() => { if (status?.connected) loadThreads(); }, [status?.connected, loadThreads]);

  // Auto-sync on first load if connected. Best-effort.
  const didSyncRef = useRef(false);
  useEffect(() => {
    if (!status?.connected || didSyncRef.current) return;
    didSyncRef.current = true;
    sync({ silent: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.connected]);

  // ── Messages of selected thread ─────────────────────────────────────────

  useEffect(() => {
    if (!selectedThreadId) { setMessages([]); return; }
    setMsgLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('email_messages')
        .select('*')
        .eq('thread_id', selectedThreadId)
        .order('sent_at', { ascending: true });
      if (error) showToast(error.message, 'error');
      else setMessages(data || []);
      setMsgLoading(false);
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 80);
    })();
  }, [selectedThreadId, showToast]);

  // ── Actions ─────────────────────────────────────────────────────────────

  async function connect() {
    try {
      const { data, error } = await supabase.functions.invoke('gmail-start', { method: 'GET' });
      if (error || data?.error) {
        showToast(data?.message || data?.error || error?.message || 'Failed to start OAuth', 'error');
        return;
      }
      window.location.href = data.auth_url;
    } catch (e) {
      showToast(e.message || 'Failed to start OAuth', 'error');
    }
  }

  async function disconnect() {
    if (!window.confirm('Disconnect Gmail? The portal will stop sending and receiving via this account.')) return;
    try {
      await supabase.functions.invoke('gmail-disconnect', { method: 'POST' });
      showToast('Gmail disconnected', 'success');
      setStatus({ ...status, connected: false, email: null });
      setThreads([]); setSelectedThreadId(null); setMessages([]);
    } catch (e) {
      showToast(e.message || 'Disconnect failed', 'error');
    }
  }

  async function sync({ silent = false } = {}) {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke('gmail-sync', { method: 'POST' });
      if (error || data?.error) {
        if (!silent) showToast(data?.error || error?.message || 'Sync failed', 'error');
      } else {
        if (!silent) showToast(`Synced ${data.synced_threads} threads · ${data.new_messages} new`, data.new_messages > 0 ? 'success' : 'info');
        await loadThreads();
        if (selectedThreadId) {
          const { data: msgs } = await supabase.from('email_messages').select('*').eq('thread_id', selectedThreadId).order('sent_at', { ascending: true });
          setMessages(msgs || []);
        }
      }
    } catch (e) {
      if (!silent) showToast(e.message || 'Sync failed', 'error');
    }
    setSyncing(false);
  }

  async function sendReply() {
    const thread = threads.find(t => t.id === selectedThreadId);
    if (!thread) return;
    if (!replyText.trim()) { showToast('Type a reply.', 'error'); return; }
    setReplying(true);
    try {
      // Determine the recipient: the most recent inbound sender.
      const lastInbound = [...messages].reverse().find(m => m.direction === 'inbound');
      const to = lastInbound?.from_email
        || (thread.participants || [])[0]
        || null;
      if (!to) { showToast('No recipient found in this thread.', 'error'); setReplying(false); return; }

      const lastMsg = messages[messages.length - 1];
      const { data, error } = await supabase.functions.invoke('gmail-send', {
        body: {
          to,
          subject:    thread.subject?.startsWith('Re: ') ? thread.subject : `Re: ${thread.subject || ''}`,
          body:       replyText.trim(),
          thread_id:  thread.gmail_thread_id,
          in_reply_to: lastMsg?.gmail_message_id,
          worker_id:  thread.worker_id || null,
          client_id:  thread.client_id || null,
        },
      });
      if (error || data?.error) {
        showToast(data?.error || error?.message || 'Send failed', 'error');
      } else {
        showToast('Reply sent', 'success');
        setReplyText('');
        // Refresh messages
        const { data: msgs } = await supabase.from('email_messages').select('*').eq('thread_id', selectedThreadId).order('sent_at', { ascending: true });
        setMessages(msgs || []);
        loadThreads();
      }
    } catch (e) {
      showToast(e.message || 'Send failed', 'error');
    }
    setReplying(false);
  }

  // ── Filtering ───────────────────────────────────────────────────────────

  const filteredThreads = useMemo(() => {
    const q = search.toLowerCase();
    return threads.filter(t => {
      if (filter === 'unread' && !t.unread) return false;
      if (filter === 'workers' && !t.worker_id) return false;
      if (filter === 'clients' && !t.client_id) return false;
      if (!q) return true;
      const haystack = `${t.subject || ''} ${(t.participants || []).join(' ')} ${t.workers?.name || ''} ${t.clients?.name || ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [threads, filter, search]);

  const selectedThread = threads.find(t => t.id === selectedThreadId);

  // ── Render ──────────────────────────────────────────────────────────────

  if (statusLoading) {
    return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}><Spinner size={36} /></div>;
  }

  if (!status?.configured) {
    return <SetupCard />;
  }

  if (!status?.connected) {
    return (
      <div style={{ maxWidth: 560, margin: '40px auto', background: C.card, border: `1px solid ${C.border}`, borderRadius: R.xl, padding: 32 }}>
        <div style={{ fontSize: 38, marginBottom: 12 }}>✉️</div>
        <h2 style={{ fontFamily: 'Syne, sans-serif', fontSize: 22, fontWeight: 700, color: C.text, margin: 0, marginBottom: 8 }}>
          Connect your Gmail
        </h2>
        <p style={{ color: C.textMuted, fontSize: 13.5, lineHeight: 1.6, margin: '0 0 20px 0' }}>
          Send and receive emails from inside the portal. Replies from workers
          and clients show up here automatically, threaded against their
          profile. Uses your existing Google Workspace or Gmail account — no
          domain verification required.
        </p>
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.md, padding: 12, marginBottom: 18, fontSize: 12, color: C.textMuted }}>
          <div style={{ color: C.text, fontWeight: 600, marginBottom: 6, fontSize: 12 }}>What we'll request</div>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            <li>Read your inbox (so replies show up here)</li>
            <li>Send mail as you (from this portal)</li>
            <li>Modify message labels (mark as read)</li>
          </ul>
        </div>
        <button onClick={connect} style={{ ...btnPrimary, width: '100%', padding: '11px 18px', fontSize: 14 }}>
          Connect Gmail →
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 0, height: 'calc(100vh - 100px)', minHeight: 500, border: `1px solid ${C.border}`, borderRadius: R.lg, overflow: 'hidden', background: C.card }}>
      {/* Left: thread list */}
      <div style={{ width: 340, borderRight: `1px solid ${C.border}`, background: C.bg, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 14px', borderBottom: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: C.textDim, fontFamily: MONO, letterSpacing: 0.5 }}>Connected as</div>
              <div style={{ fontSize: 12.5, color: C.text, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status.email}</div>
            </div>
            <button onClick={() => sync()} disabled={syncing} style={btnSmall} title="Pull recent emails from Gmail">
              {syncing ? '⏳' : '↻'} Sync
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setComposeOpen(true)} style={{ ...btnPrimary, flex: 1, padding: '7px 10px', fontSize: 12 }}>✎ Compose</button>
            <button onClick={disconnect} style={{ ...btnSecondary, padding: '7px 10px', fontSize: 11 }} title="Disconnect Gmail">⛔</button>
          </div>
          <input
            style={{ ...inputStyle, padding: '7px 10px', fontSize: 12 }}
            placeholder="Search threads…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 4 }}>
            {[
              { id: 'all',     label: 'All' },
              { id: 'unread',  label: 'Unread' },
              { id: 'workers', label: 'Workers' },
              { id: 'clients', label: 'Clients' },
            ].map(f => {
              const active = filter === f.id;
              return (
                <button key={f.id} onClick={() => setFilter(f.id)} style={{
                  background: active ? C.cardHover : 'transparent',
                  color: active ? C.text : C.textMuted,
                  border: `1px solid ${active ? C.borderStrong : C.border}`,
                  borderRadius: R.sm, padding: '3px 8px', cursor: 'pointer',
                  fontSize: 11, fontWeight: active ? 600 : 500, flex: 1,
                }}>{f.label}</button>
              );
            })}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {threadsLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 30 }}><Spinner /></div>
          ) : filteredThreads.length === 0 ? (
            <div style={{ padding: '40px 20px', color: C.textMuted, fontSize: 13, textAlign: 'center' }}>
              {threads.length === 0 ? 'No threads yet. Click Sync or compose your first email.' : 'No threads match.'}
            </div>
          ) : filteredThreads.map(t => {
            const isSelected = t.id === selectedThreadId;
            const otherName = t.workers?.name || t.clients?.name || (t.participants || [])[0] || '(no participants)';
            const otherEmail = (t.participants || [])[0] || '';
            return (
              <div key={t.id} onClick={() => setSelectedThreadId(t.id)} style={{
                padding: '11px 13px',
                borderBottom: `1px solid ${C.border}`,
                background: isSelected ? C.cardHover : (t.unread ? 'rgba(56,189,248,0.04)' : 'transparent'),
                cursor: 'pointer', borderLeft: isSelected ? `3px solid ${C.accent}` : '3px solid transparent',
                transition: 'background 120ms',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <div style={{ width: 30, height: 30, borderRadius: '50%', background: avatarColor(otherEmail), color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                    {initials(otherName)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <strong style={{ fontSize: 13, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{otherName}</strong>
                      <span style={{ fontSize: 10.5, color: C.textDim, fontFamily: MONO }}>{fmtAgo(t.last_message_at)}</span>
                    </div>
                    <div style={{ fontSize: 12, color: t.unread ? C.text : C.textMuted, fontWeight: t.unread ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.subject || '(no subject)'}
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      {t.workers && <span style={{ fontSize: 9.5, color: C.success, fontFamily: MONO, background: 'rgba(34,197,94,0.10)', padding: '1px 6px', borderRadius: 999 }}>WORKER</span>}
                      {t.clients && <span style={{ fontSize: 9.5, color: C.accent, fontFamily: MONO, background: 'rgba(249,115,22,0.10)', padding: '1px 6px', borderRadius: 999 }}>CLIENT</span>}
                      {t.unread && <span style={{ fontSize: 9.5, color: C.info, fontFamily: MONO }}>● NEW</span>}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: thread detail */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {!selectedThread ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
            <EmptyState message="Select a thread to read the conversation." icon="📨" />
          </div>
        ) : (
          <>
            <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.border}`, background: C.card }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 4 }}>
                    {selectedThread.subject || '(no subject)'}
                  </div>
                  <div style={{ fontSize: 12, color: C.textMuted }}>
                    {selectedThread.workers?.name && <span style={{ color: C.success }}>👷 {selectedThread.workers.name} · </span>}
                    {selectedThread.clients?.name && <span style={{ color: C.accent }}>🏗 {selectedThread.clients.name} · </span>}
                    {(selectedThread.participants || []).join(', ')}
                  </div>
                </div>
                <button onClick={() => sync()} disabled={syncing} style={btnSmall}>↻</button>
              </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: 18, background: C.bg }}>
              {msgLoading ? <Spinner /> : messages.map(m => (
                <MessageBubble key={m.id} message={m} />
              ))}
              <div ref={messagesEndRef} />
            </div>

            <div style={{ padding: 14, borderTop: `1px solid ${C.border}`, background: C.card }}>
              <textarea
                style={{ ...inputStyle, minHeight: 80, resize: 'vertical', fontFamily: 'inherit' }}
                placeholder={`Reply to ${selectedThread.workers?.name || selectedThread.clients?.name || (selectedThread.participants || [])[0] || '…'}`}
                value={replyText}
                onChange={e => setReplyText(e.target.value)}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                <button onClick={sendReply} disabled={replying || !replyText.trim()} style={btnPrimary}>
                  {replying ? 'Sending…' : 'Send Reply →'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {composeOpen && (
        <ComposeModal
          onClose={() => setComposeOpen(false)}
          onSent={() => { setComposeOpen(false); loadThreads(); }}
          showToast={showToast}
        />
      )}
    </div>
  );
}

function MessageBubble({ message }) {
  const isOutbound = message.direction === 'outbound';
  return (
    <div style={{
      display: 'flex', justifyContent: isOutbound ? 'flex-end' : 'flex-start',
      marginBottom: 12,
    }}>
      <div style={{
        maxWidth: '78%', background: isOutbound ? 'rgba(249,115,22,0.12)' : C.card,
        border: `1px solid ${isOutbound ? C.accentBorder : C.border}`,
        borderRadius: R.lg, padding: '10px 14px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: isOutbound ? C.accent : C.text }}>
            {isOutbound ? 'You' : (message.from_name || message.from_email || '—')}
          </span>
          <span style={{ fontSize: 10.5, color: C.textDim, fontFamily: MONO, marginLeft: 'auto' }}>
            {fmtFull(message.sent_at)}
          </span>
        </div>
        <div style={{ fontSize: 13.5, color: C.text, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {message.body_text || message.snippet || '(no content)'}
        </div>
        {message.has_attachments && (
          <div style={{ fontSize: 11, color: C.textDim, marginTop: 6, fontFamily: MONO }}>
            📎 attachments (view in Gmail)
          </div>
        )}
      </div>
    </div>
  );
}

function ComposeModal({ onClose, onSent, showToast }) {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [workers, setWorkers] = useState([]);
  const [clients, setClients] = useState([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    (async () => {
      const [w, c] = await Promise.all([
        supabase.from('workers').select('id, name, email').not('email', 'is', null).order('name'),
        supabase.from('clients').select('id, name, contact, contact_email').not('contact_email', 'is', null).order('name'),
      ]);
      setWorkers(w.data || []);
      setClients(c.data || []);
    })();
  }, []);

  async function send() {
    if (!to.trim() || !subject.trim() || !body.trim()) {
      showToast('Fill in recipient, subject and message.', 'error');
      return;
    }
    setSending(true);
    try {
      const matchedWorker = workers.find(w => w.email?.toLowerCase() === to.toLowerCase());
      const matchedClient = clients.find(c => c.contact_email?.toLowerCase() === to.toLowerCase());
      const { data, error } = await supabase.functions.invoke('gmail-send', {
        body: {
          to:        to.trim(),
          subject:   subject.trim(),
          body:      body.trim(),
          worker_id: matchedWorker?.id || null,
          client_id: matchedClient?.id || null,
        },
      });
      if (error || data?.error) {
        showToast(data?.error || error?.message || 'Send failed', 'error');
      } else {
        showToast('Email sent', 'success');
        onSent();
      }
    } catch (e) {
      showToast(e.message || 'Send failed', 'error');
    }
    setSending(false);
  }

  return (
    <Modal title="✎ New Email" onClose={onClose} width={620}>
      <Field label="To">
        <input style={inputStyle} list="compose-recipients" value={to} onChange={e => setTo(e.target.value)} placeholder="email@example.com" />
        <datalist id="compose-recipients">
          {workers.map(w => <option key={`w-${w.id}`} value={w.email}>{w.name} · worker</option>)}
          {clients.map(c => <option key={`c-${c.id}`} value={c.contact_email}>{c.name} · client</option>)}
        </datalist>
      </Field>
      <Field label="Subject">
        <input style={inputStyle} value={subject} onChange={e => setSubject(e.target.value)} />
      </Field>
      <Field label="Message">
        <textarea style={{ ...inputStyle, minHeight: 160, resize: 'vertical', fontFamily: 'inherit' }} value={body} onChange={e => setBody(e.target.value)} />
      </Field>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={btnSecondary}>Cancel</button>
        <button onClick={send} disabled={sending} style={btnPrimary}>{sending ? 'Sending…' : 'Send →'}</button>
      </div>
    </Modal>
  );
}

function SetupCard() {
  return (
    <div style={{ maxWidth: 680, margin: '20px auto', background: C.card, border: `1px solid ${C.border}`, borderRadius: R.xl, padding: 32 }}>
      <div style={{ fontSize: 38, marginBottom: 12 }}>⚙️</div>
      <h2 style={{ fontFamily: 'Syne, sans-serif', fontSize: 22, fontWeight: 700, color: C.text, margin: 0, marginBottom: 8 }}>
        Inbox not set up yet
      </h2>
      <p style={{ color: C.textMuted, fontSize: 13.5, lineHeight: 1.6, margin: '0 0 16px 0' }}>
        Gmail OAuth credentials aren't configured. Follow these one-time steps to enable the in-app inbox:
      </p>
      <ol style={{ color: C.text, fontSize: 13, lineHeight: 1.8, paddingLeft: 22, margin: 0 }}>
        <li>Open <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer" style={{ color: C.accent }}>Google Cloud Console</a>, create (or pick) a project.</li>
        <li><strong>APIs &amp; Services → Library</strong> → enable <strong>Gmail API</strong>.</li>
        <li><strong>APIs &amp; Services → OAuth consent screen</strong> → set up External, scopes <code style={{ color: C.accent }}>gmail.modify</code>, <code style={{ color: C.accent }}>userinfo.email</code>.</li>
        <li><strong>APIs &amp; Services → Credentials → Create OAuth client ID</strong> → Web application.</li>
        <li>Authorized redirect URI: <code style={{ color: C.accent, fontFamily: MONO, fontSize: 12 }}>https://tsizneslellcqusjwtub.supabase.co/functions/v1/gmail-callback</code></li>
        <li>Copy the Client ID and Client Secret.</li>
        <li>In Supabase → Project Settings → Edge Functions → Secrets, set:
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.sm, padding: 10, marginTop: 6, fontFamily: MONO, fontSize: 12 }}>
            GMAIL_CLIENT_ID = …<br/>
            GMAIL_CLIENT_SECRET = …
          </div>
        </li>
        <li>Reload this page. The Connect Gmail button will appear.</li>
      </ol>
      <p style={{ color: C.textDim, fontSize: 12, marginTop: 16 }}>
        Edge functions <code style={{ color: C.accent }}>gmail-start</code>, <code style={{ color: C.accent }}>gmail-callback</code>, <code style={{ color: C.accent }}>gmail-send</code>, <code style={{ color: C.accent }}>gmail-sync</code>, <code style={{ color: C.accent }}>gmail-status</code>, <code style={{ color: C.accent }}>gmail-disconnect</code> are already deployed and waiting on the credentials above.
      </p>
    </div>
  );
}
