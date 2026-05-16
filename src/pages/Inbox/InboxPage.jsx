import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { Spinner, EmptyState, Modal, Field } from '../../components';
import { modifyThread, loadTemplates, interpolate, buildTemplateContext, placeholderHints } from './inboxApi';

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

const FILTERS = [
  { id: 'inbox',     label: 'Inbox',     desc: 'All non-archived threads' },
  { id: 'unread',    label: 'Unread',    desc: 'Unread only' },
  { id: 'starred',   label: 'Starred',   desc: 'Starred threads' },
  { id: 'workers',   label: 'Workers',   desc: 'Workers' },
  { id: 'clients',   label: 'Clients',   desc: 'Clients' },
  { id: 'archived',  label: 'Archived',  desc: 'Archived threads' },
];

export function InboxPage({ showToast }) {
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [threads, setThreads] = useState([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [filter, setFilter] = useState('inbox');
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [addSenderOpen, setAddSenderOpen] = useState(null); // { kind: 'worker'|'client', email, name }
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('gmail_connected') === '1') {
      showToast('Team email connected', 'success');
      window.history.replaceState({}, '', window.location.pathname);
      loadStatus();
    }
    const err = params.get('gmail_error');
    if (err) {
      showToast(`Gmail connection failed: ${err}`, 'error');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [loadStatus, showToast]);

  // Templates — loaded once. Re-fetched after Templates page edits via window event.
  const refreshTemplates = useCallback(() => {
    loadTemplates().then(setTemplates).catch(() => {});
  }, []);
  useEffect(() => { refreshTemplates(); }, [refreshTemplates]);

  // ── Threads ─────────────────────────────────────────────────────────────

  const loadThreads = useCallback(async () => {
    setThreadsLoading(true);
    const { data, error } = await supabase
      .from('email_threads')
      .select('*, workers(id, name), clients(id, name)')
      .or('worker_id.not.is.null,client_id.not.is.null')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(300);
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

  // Deep-link: another page asked us to focus a thread (via sessionStorage).
  useEffect(() => {
    if (!threads.length) return;
    const focus = window.sessionStorage.getItem('inbox_focus_thread');
    if (!focus) return;
    window.sessionStorage.removeItem('inbox_focus_thread');
    if (threads.some(t => t.id === focus)) setSelectedThreadId(focus);
  }, [threads]);

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

  // Auto-mark-read when opening an unread thread. Fire-and-forget; Gmail mirror.
  useEffect(() => {
    if (!selectedThreadId) return;
    const t = threads.find(x => x.id === selectedThreadId);
    if (!t?.unread) return;
    modifyThread(selectedThreadId, 'mark_read')
      .then((updated) => setThreads(prev => prev.map(x => x.id === updated.id ? { ...x, ...updated } : x)))
      .catch(() => {});
  }, [selectedThreadId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  async function switchAccount() {
    if (!window.confirm('Switch the team email account?\n\nThe current connection will be replaced. Best to use a shared inbox (e.g. ops@yourdomain.com.au) so the whole team sees the same thread history.')) return;
    connect();
  }

  async function disconnect() {
    if (!window.confirm('Disconnect the team email? The portal will stop sending and receiving via this account.')) return;
    try {
      await supabase.functions.invoke('gmail-disconnect', { method: 'POST' });
      showToast('Team email disconnected', 'success');
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
        if (!silent) {
          const matched   = data.synced_threads ?? 0;
          const newMsgs   = data.new_messages ?? 0;
          const fetched   = data.fetched_threads ?? matched;
          const unmatched = Math.max(0, fetched - matched);
          let msg = `Synced ${matched} thread${matched === 1 ? '' : 's'} · ${newMsgs} new`;
          if (unmatched > 0) msg += ` · ${unmatched} skipped (no worker/client match)`;
          if (fetched === 0) msg = 'Gmail returned no recent threads.';
          showToast(msg, newMsgs > 0 ? 'success' : 'info');
        }
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

  async function doModify(threadId, action) {
    try {
      const updated = await modifyThread(threadId, action);
      setThreads(prev => prev.map(x => x.id === updated.id ? { ...x, ...updated } : x));
      // If the action archives, drop the selection so the right pane resets.
      if (action === 'archive' && filter !== 'archived') setSelectedThreadId(null);
    } catch (e) {
      showToast(e.message || 'Action failed', 'error');
    }
  }

  async function sendReply() {
    const thread = threads.find(t => t.id === selectedThreadId);
    if (!thread) return;
    if (!replyText.trim()) { showToast('Type a reply.', 'error'); return; }
    setReplying(true);
    try {
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
      // Default: hide archived unless explicitly viewing them.
      if (filter !== 'archived' && t.archived) return false;
      if (filter === 'unread'   && !t.unread)   return false;
      if (filter === 'starred'  && !t.starred)  return false;
      if (filter === 'workers'  && !t.worker_id) return false;
      if (filter === 'clients'  && !t.client_id) return false;
      if (filter === 'archived' && !t.archived) return false;
      if (!q) return true;
      const haystack = `${t.subject || ''} ${(t.participants || []).join(' ')} ${t.workers?.name || ''} ${t.clients?.name || ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [threads, filter, search]);

  const counts = useMemo(() => ({
    inbox:    threads.filter(t => !t.archived).length,
    unread:   threads.filter(t => t.unread && !t.archived).length,
    starred:  threads.filter(t => t.starred && !t.archived).length,
    archived: threads.filter(t => t.archived).length,
  }), [threads]);

  const selectedThread = threads.find(t => t.id === selectedThreadId);
  const senderForAdd = useMemo(() => {
    if (!selectedThread) return null;
    if (selectedThread.worker_id || selectedThread.client_id) return null;
    const lastInbound = [...messages].reverse().find(m => m.direction === 'inbound');
    if (!lastInbound?.from_email) return null;
    return { email: lastInbound.from_email, name: lastInbound.from_name || '' };
  }, [selectedThread, messages]);

  // ── Render ──────────────────────────────────────────────────────────────

  if (statusLoading) {
    return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}><Spinner size={36} /></div>;
  }

  if (!status?.configured) return <SetupCard />;
  if (!status?.connected)  return <ConnectCard onConnect={connect} />;

  return (
    <div style={{ display: 'flex', gap: 0, height: 'calc(100vh - 100px)', minHeight: 500, border: `1px solid ${C.border}`, borderRadius: R.lg, overflow: 'hidden', background: C.card }}>
      {/* Left: thread list */}
      <div style={{ width: 340, borderRight: `1px solid ${C.border}`, background: C.bg, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 14px', borderBottom: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 9.5, color: C.textDim, fontFamily: MONO, letterSpacing: 1.4, textTransform: 'uppercase', fontWeight: 700 }}>Team Email</div>
              <div style={{ fontSize: 12.5, color: C.text, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={status.email}>
                {status.email}
              </div>
              <div style={{ fontSize: 10, color: C.textDim, marginTop: 2 }}>Shared inbox for the whole team</div>
            </div>
            <button onClick={() => sync()} disabled={syncing} style={btnSmall} title="Pull recent emails from Gmail">
              {syncing ? '⏳' : '↻'} Sync
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setComposeOpen(true)} style={{ ...btnPrimary, flex: 1, padding: '7px 10px', fontSize: 12 }}>✎ Compose</button>
            <button onClick={switchAccount} style={{ ...btnSecondary, padding: '7px 10px', fontSize: 11 }} title="Switch to a different team email account">↔</button>
            <button onClick={disconnect} style={{ ...btnSecondary, padding: '7px 10px', fontSize: 11 }} title="Disconnect team email">⛔</button>
          </div>
          <input
            style={{ ...inputStyle, padding: '7px 10px', fontSize: 12 }}
            placeholder="Search threads…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {FILTERS.map(f => {
              const active = filter === f.id;
              const count = counts[f.id];
              return (
                <button key={f.id} title={f.desc} onClick={() => setFilter(f.id)} style={{
                  background: active ? C.cardHover : 'transparent',
                  color: active ? C.text : C.textMuted,
                  border: `1px solid ${active ? C.borderStrong : C.border}`,
                  borderRadius: R.sm, padding: '3px 8px', cursor: 'pointer',
                  fontSize: 11, fontWeight: active ? 600 : 500,
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}>
                  {f.label}
                  {typeof count === 'number' && count > 0 && (
                    <span style={{ fontFamily: MONO, fontSize: 10, color: active ? C.text : C.textDim }}>{count}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {threadsLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 30 }}><Spinner /></div>
          ) : filteredThreads.length === 0 ? (
            <div style={{ padding: '32px 20px', color: C.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 1.5 }}>
              {threads.length === 0 ? (
                <>
                  No threads yet.<br/>
                  <span style={{ fontSize: 11.5, color: C.textDim }}>
                    Only emails involving a worker or client are pulled in.
                    Add the contact under <strong style={{ color: C.text }}>Workers</strong> or <strong style={{ color: C.text }}>Clients</strong> (or add their domain to a client), then click Sync.
                  </span>
                </>
              ) : 'No threads match.'}
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
                      {t.starred && <span style={{ fontSize: 11, color: '#fbbf24' }}>★</span>}
                      <span style={{ fontSize: 10.5, color: C.textDim, fontFamily: MONO }}>{fmtAgo(t.last_message_at)}</span>
                    </div>
                    <div style={{ fontSize: 12, color: t.unread ? C.text : C.textMuted, fontWeight: t.unread ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.subject || '(no subject)'}
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      {t.workers && <span style={{ fontSize: 9.5, color: C.success, fontFamily: MONO, background: 'rgba(34,197,94,0.10)', padding: '1px 6px', borderRadius: 999 }}>WORKER</span>}
                      {t.clients && <span style={{ fontSize: 9.5, color: C.accent, fontFamily: MONO, background: 'rgba(249,115,22,0.10)', padding: '1px 6px', borderRadius: 999 }}>CLIENT</span>}
                      {t.matched_by_domain && !t.workers && <span title={`domain: ${t.matched_by_domain}`} style={{ fontSize: 9.5, color: C.textDim, fontFamily: MONO }}>@{t.matched_by_domain}</span>}
                      {t.archived && <span style={{ fontSize: 9.5, color: C.textDim, fontFamily: MONO }}>archived</span>}
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
            <div style={{ padding: '12px 18px', borderBottom: `1px solid ${C.border}`, background: C.card }}>
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
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => doModify(selectedThread.id, selectedThread.starred ? 'unstar' : 'star')}
                    style={{ ...btnSmall, color: selectedThread.starred ? '#fbbf24' : C.text }}
                    title={selectedThread.starred ? 'Remove star' : 'Star thread'}
                  >
                    {selectedThread.starred ? '★' : '☆'}
                  </button>
                  <button
                    onClick={() => doModify(selectedThread.id, 'mark_unread')}
                    style={btnSmall}
                    title="Mark as unread"
                  >● </button>
                  <button
                    onClick={() => doModify(selectedThread.id, selectedThread.archived ? 'unarchive' : 'archive')}
                    style={btnSmall}
                    title={selectedThread.archived ? 'Move back to Inbox' : 'Archive thread'}
                  >
                    {selectedThread.archived ? '↺' : '🗄'}
                  </button>
                  <button onClick={() => sync()} disabled={syncing} style={btnSmall} title="Re-sync">↻</button>
                </div>
              </div>

              {senderForAdd && (
                <div style={{
                  marginTop: 10, padding: '8px 12px',
                  background: C.bg, border: `1px dashed ${C.border}`, borderRadius: R.md,
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                }}>
                  <span style={{ fontSize: 12, color: C.textMuted, flex: 1, minWidth: 200 }}>
                    <strong style={{ color: C.text }}>{senderForAdd.email}</strong> isn't linked to a worker or client.
                  </span>
                  <button
                    style={btnSmall}
                    onClick={() => setAddSenderOpen({ kind: 'worker', email: senderForAdd.email, name: senderForAdd.name, threadId: selectedThread.id })}
                  >+ Add as worker</button>
                  <button
                    style={btnSmall}
                    onClick={() => setAddSenderOpen({ kind: 'client', email: senderForAdd.email, name: senderForAdd.name, threadId: selectedThread.id })}
                  >+ Add as client</button>
                </div>
              )}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: 18, background: C.bg }}>
              {msgLoading ? <Spinner /> : messages.map(m => (
                <MessageBubble key={m.id} message={m} />
              ))}
              <div ref={messagesEndRef} />
            </div>

            <div style={{ padding: 14, borderTop: `1px solid ${C.border}`, background: C.card }}>
              <ReplyBar
                templates={templates}
                onPickTemplate={(tpl) => {
                  // For replies we only fill the body. Use whatever context we have
                  // from the thread's worker/client to interpolate placeholders.
                  const ctx = buildTemplateContext({
                    worker: selectedThread.workers ? { name: selectedThread.workers.name } : null,
                    client: selectedThread.clients ? { name: selectedThread.clients.name } : null,
                  });
                  setReplyText((prev) => (prev ? prev + '\n\n' : '') + interpolate(tpl.body, ctx));
                }}
              />
              <textarea
                style={{ ...inputStyle, minHeight: 96, resize: 'vertical', fontFamily: 'inherit' }}
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
          templates={templates}
          onClose={() => setComposeOpen(false)}
          onSent={() => { setComposeOpen(false); loadThreads(); }}
          showToast={showToast}
        />
      )}

      {addSenderOpen && (
        <AddSenderModal
          payload={addSenderOpen}
          onClose={() => setAddSenderOpen(null)}
          onDone={async () => {
            setAddSenderOpen(null);
            showToast('Contact added — re-syncing inbox', 'success');
            await sync({ silent: true });
          }}
          showToast={showToast}
        />
      )}
    </div>
  );
}

// ── Reply template bar ─────────────────────────────────────────────────────

function ReplyBar({ templates, onPickTemplate }) {
  const [picking, setPicking] = useState(false);
  if (!templates?.length) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <button type="button" onClick={() => setPicking(p => !p)} style={btnSmall}>
        📝 Templates
      </button>
      {picking && (
        <select
          autoFocus
          style={{ ...inputStyle, padding: '6px 8px', fontSize: 12, maxWidth: 280 }}
          defaultValue=""
          onChange={(e) => {
            const tpl = templates.find(t => t.id === e.target.value);
            if (tpl) { onPickTemplate(tpl); setPicking(false); }
          }}
          onBlur={() => setPicking(false)}
        >
          <option value="" disabled>Pick a template…</option>
          {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
      <span style={{ fontSize: 11, color: C.textDim }}>
        Placeholders: <code style={{ fontFamily: MONO, color: C.textMuted }}>{'{{worker_name}}'}</code>, <code style={{ fontFamily: MONO, color: C.textMuted }}>{'{{client_name}}'}</code>, …
      </span>
    </div>
  );
}

// ── Message bubble ─────────────────────────────────────────────────────────

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

// ── Compose modal ──────────────────────────────────────────────────────────

function ComposeModal({ onClose, onSent, showToast, templates }) {
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

  const matchedWorker = workers.find(w => w.email?.toLowerCase() === to.toLowerCase());
  const matchedClient = clients.find(c => c.contact_email?.toLowerCase() === to.toLowerCase());

  function applyTemplate(tpl) {
    const ctx = buildTemplateContext({
      worker: matchedWorker ? { name: matchedWorker.name, email: matchedWorker.email } : null,
      client: matchedClient ? { name: matchedClient.name, contact: matchedClient.contact } : null,
    });
    if (!subject.trim() || window.confirm('Replace subject with template?')) {
      setSubject(interpolate(tpl.subject, ctx));
    }
    setBody((prev) => (prev ? prev + '\n\n' : '') + interpolate(tpl.body, ctx));
  }

  async function send() {
    if (!to.trim() || !subject.trim() || !body.trim()) {
      showToast('Fill in recipient, subject and message.', 'error');
      return;
    }
    setSending(true);
    try {
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
      {templates?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <select
            style={{ ...inputStyle, padding: '7px 10px', fontSize: 12 }}
            defaultValue=""
            onChange={e => {
              const tpl = templates.find(t => t.id === e.target.value);
              if (tpl) applyTemplate(tpl);
              e.target.value = '';
            }}
          >
            <option value="" disabled>📝 Insert a template…</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      )}
      <Field label="Subject">
        <input style={inputStyle} value={subject} onChange={e => setSubject(e.target.value)} />
      </Field>
      <Field label="Message" hint={`Placeholders supported: ${placeholderHints().slice(0, 5).map(p => `{{${p}}}`).join(', ')}…`}>
        <textarea style={{ ...inputStyle, minHeight: 160, resize: 'vertical', fontFamily: 'inherit' }} value={body} onChange={e => setBody(e.target.value)} />
      </Field>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={btnSecondary}>Cancel</button>
        <button onClick={send} disabled={sending} style={btnPrimary}>{sending ? 'Sending…' : 'Send →'}</button>
      </div>
    </Modal>
  );
}

// ── Add unknown sender modal ───────────────────────────────────────────────

function AddSenderModal({ payload, onClose, onDone, showToast }) {
  const { kind, email, name: initialName, threadId } = payload;
  const [name, setName]   = useState(initialName || '');
  const [extra, setExtra] = useState({ mobile: '', site: '', contact: '' });
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) { showToast('Name is required.', 'error'); return; }
    setSaving(true);
    try {
      if (kind === 'worker') {
        const { data: w, error } = await supabase
          .from('workers')
          .insert([{ name: name.trim(), email, mobile: extra.mobile || null, status: 'casual', app_status: 'Pending Profile' }])
          .select('id')
          .single();
        if (error) throw error;
        await supabase.from('email_threads').update({ worker_id: w.id }).eq('id', threadId);
      } else {
        const domain = (email.split('@')[1] || '').toLowerCase();
        const skipDomain = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','live.com'].includes(domain);
        const { data: c, error } = await supabase
          .from('clients')
          .insert([{
            name: name.trim(),
            contact: extra.contact || initialName || '',
            contact_email: email,
            site: extra.site || '',
            email_domains: skipDomain ? [] : [domain],
          }])
          .select('id')
          .single();
        if (error) throw error;
        await supabase.from('email_threads').update({ client_id: c.id }).eq('id', threadId);
      }
      onDone();
    } catch (e) {
      showToast(e.message || 'Failed to add', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={kind === 'worker' ? 'Add as Worker' : 'Add as Client'} onClose={onClose} width={500}>
      <p style={{ color: C.textMuted, fontSize: 13, margin: '0 0 16px 0' }}>
        Creating a {kind} from <strong style={{ color: C.text, fontFamily: MONO }}>{email}</strong>.
        You can fill in the rest later under {kind === 'worker' ? 'Workers' : 'Clients & Rates'}.
      </p>
      <Field label={kind === 'worker' ? 'Worker name *' : 'Company name *'}>
        <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} autoFocus />
      </Field>
      {kind === 'worker' ? (
        <Field label="Mobile (optional)">
          <input style={inputStyle} value={extra.mobile} onChange={e => setExtra(x => ({ ...x, mobile: e.target.value }))} placeholder="0400 000 000" />
        </Field>
      ) : (
        <>
          <Field label="Contact person (optional)">
            <input style={inputStyle} value={extra.contact} onChange={e => setExtra(x => ({ ...x, contact: e.target.value }))} placeholder={initialName} />
          </Field>
          <Field label="Site / project (optional)">
            <input style={inputStyle} value={extra.site} onChange={e => setExtra(x => ({ ...x, site: e.target.value }))} />
          </Field>
        </>
      )}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
        <button onClick={onClose} style={btnSecondary}>Cancel</button>
        <button onClick={save} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Create'}</button>
      </div>
    </Modal>
  );
}

// ── Connect screens ─────────────────────────────────────────────────────────

function ConnectCard({ onConnect }) {
  return (
    <div style={{ maxWidth: 580, margin: '40px auto', background: C.card, border: `1px solid ${C.border}`, borderRadius: R.xl, padding: 32 }}>
      <div style={{ fontSize: 38, marginBottom: 12 }}>✉️</div>
      <h2 style={{ fontFamily: 'Syne, sans-serif', fontSize: 22, fontWeight: 700, color: C.text, margin: 0, marginBottom: 8 }}>
        Connect the team email
      </h2>
      <p style={{ color: C.textMuted, fontSize: 13.5, lineHeight: 1.6, margin: '0 0 20px 0' }}>
        This becomes the <strong style={{ color: C.text }}>shared inbox</strong> for everyone using the portal —
        replies from workers and clients show up here automatically, threaded
        against their profile. Use a Google Workspace or Gmail account dedicated
        to ops (e.g. <code style={{ color: C.accent, fontFamily: MONO, fontSize: 12 }}>ops@yourcompany.com.au</code>).
        Avoid a personal account — the whole team will see every email.
      </p>
      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.md, padding: 12, marginBottom: 18, fontSize: 12, color: C.textMuted }}>
        <div style={{ color: C.text, fontWeight: 600, marginBottom: 6, fontSize: 12 }}>What we'll request</div>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>Read messages (so replies show here)</li>
          <li>Send mail on behalf of this account</li>
          <li>Modify labels (mark read, star, archive)</li>
        </ul>
      </div>
      <button onClick={onConnect} style={{ ...btnPrimary, width: '100%', padding: '11px 18px', fontSize: 14 }}>
        Connect team email →
      </button>
    </div>
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
        <li>Reload this page. The Connect button will appear.</li>
      </ol>
    </div>
  );
}
