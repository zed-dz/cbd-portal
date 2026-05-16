import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, btnSmall } from '../../theme';
import { Spinner } from '../index';

// Compact list of recent email threads with this worker or client. Designed
// to slot into the Worker / Client edit modal as a side panel.
//
// Props: { workerId?, clientId?, onOpenInbox?: (threadId) => void }
//
// One of workerId / clientId must be provided.
export function EmailHistoryPanel({ workerId, clientId, onOpenInbox, limit = 6 }) {
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase
      .from('email_threads')
      .select('id, subject, last_message_at, unread, starred, participants')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (workerId)      q = q.eq('worker_id', workerId);
    else if (clientId) q = q.eq('client_id', clientId);
    else { setThreads([]); setLoading(false); return; }
    const { data, error } = await q;
    if (!error) setThreads(data || []);
    setLoading(false);
  }, [workerId, clientId, limit]);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div style={panelStyle}>
      <div style={headStyle}>Recent emails</div>
      <div style={{ padding: 18, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
    </div>
  );

  if (!threads.length) return (
    <div style={panelStyle}>
      <div style={headStyle}>Recent emails</div>
      <div style={{ padding: '14px 14px 16px', fontSize: 12, color: C.textDim }}>
        No emails with this {workerId ? 'worker' : 'client'} yet. Send one from the Inbox or via the Compose button there.
      </div>
    </div>
  );

  return (
    <div style={panelStyle}>
      <div style={headStyle}>
        <span>Recent emails</span>
        <span style={{ fontSize: 10, fontFamily: MONO, color: C.textDim, letterSpacing: 1 }}>{threads.length}</span>
      </div>
      <div>
        {threads.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => onOpenInbox?.(t.id)}
            style={{
              width: '100%', textAlign: 'left',
              background: 'transparent',
              border: 'none', borderTop: `1px solid ${C.border}`,
              padding: '9px 14px', cursor: onOpenInbox ? 'pointer' : 'default',
              color: C.text,
            }}
            onMouseEnter={e => { if (onOpenInbox) e.currentTarget.style.background = C.cardHover; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span style={{ fontSize: 12.5, fontWeight: t.unread ? 700 : 500, color: t.unread ? C.text : C.textMuted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.subject || '(no subject)'}
              </span>
              {t.starred && <span style={{ fontSize: 11, color: '#fbbf24' }}>★</span>}
              <span style={{ fontSize: 10, fontFamily: MONO, color: C.textDim, whiteSpace: 'nowrap' }}>{fmtAgo(t.last_message_at)}</span>
            </div>
            <div style={{ fontSize: 11, color: C.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {(t.participants || []).join(', ')}
            </div>
          </button>
        ))}
      </div>
      {onOpenInbox && (
        <div style={{ padding: '8px 14px 10px', borderTop: `1px solid ${C.border}` }}>
          <button type="button" onClick={() => onOpenInbox(null)} style={{ ...btnSmall, width: '100%' }}>
            Open Inbox →
          </button>
        </div>
      )}
    </div>
  );
}

function fmtAgo(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 3600)     return `${Math.max(1, Math.floor(diff / 60))}m`;
  if (diff < 86400)    return `${Math.floor(diff / 3600)}h`;
  if (diff < 7*86400)  return `${Math.floor(diff / 86400)}d`;
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' });
}

const panelStyle = {
  background: C.bg,
  border: `1px solid ${C.border}`,
  borderRadius: R.md,
  overflow: 'hidden',
};

const headStyle = {
  padding: '8px 14px',
  background: C.card,
  borderBottom: `1px solid ${C.border}`,
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: 1.2,
  textTransform: 'uppercase',
  color: C.textMuted,
  fontFamily: MONO,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};
