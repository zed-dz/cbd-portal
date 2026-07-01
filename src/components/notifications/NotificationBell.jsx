import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO } from '../../theme';

// Relative "x ago" time for the notification list.
function timeAgo(ts) {
  if (!ts) return '';
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(ts).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' });
}

const ICONS = {
  allocation_sent: '📤',
  allocation_accepted: '✅',
  allocation_declined: '❌',
  allocation: '📋',
};

// Admin notification bell + dropdown. Uses a Supabase Realtime subscription on
// the `notifications` table so new rows appear instantly (a slow 3-min poll
// stays as a safety net if the socket drops).
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    setItems(data || []);
    setLoading(false);
  }, []);

  // Initial load + Realtime subscription on INSERT. A slow poll (3 min) is kept
  // only as a safety net in case the websocket drops.
  useEffect(() => {
    load();
    const channel = supabase
      .channel('notifications-bell')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, (payload) => {
        const row = payload.new;
        if (!row) { load(); return; }
        // Prepend the new row (de-dupe if a poll already grabbed it), cap at 50.
        setItems(prev => (prev.some(i => i.id === row.id) ? prev : [row, ...prev].slice(0, 50)));
      })
      .subscribe();
    const t = setInterval(load, 180000);
    return () => { clearInterval(t); supabase.removeChannel(channel); };
  }, [load]);

  // Refresh when the admin opens an allocation-create elsewhere — listen for a
  // lightweight window event so the bell updates immediately after a send.
  useEffect(() => {
    const onPing = () => load();
    window.addEventListener('cbd:notify', onPing);
    return () => window.removeEventListener('cbd:notify', onPing);
  }, [load]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const unread = items.filter(i => !i.read).length;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) load();
  };

  const markAllRead = async () => {
    const ids = items.filter(i => !i.read).map(i => i.id);
    if (!ids.length) return;
    setItems(items.map(i => ({ ...i, read: true })));
    await supabase.from('notifications').update({ read: true }).in('id', ids);
  };

  const markRead = async (id) => {
    setItems(items.map(i => (i.id === id ? { ...i, read: true } : i)));
    await supabase.from('notifications').update({ read: true }).eq('id', id);
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        onClick={toggle}
        title="Notifications"
        style={{
          background: 'transparent', border: `1px solid ${C.border}`, color: C.text,
          borderRadius: R.md, padding: '6px 10px', cursor: 'pointer', fontSize: 15,
          position: 'relative', lineHeight: 1, display: 'inline-flex', alignItems: 'center',
        }}
      >
        🔔
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: -6, right: -6, background: C.accent, color: '#fff',
            borderRadius: R.pill, fontSize: 10, fontWeight: 800, padding: '1px 6px',
            fontFamily: MONO, minWidth: 18, textAlign: 'center', boxShadow: '0 0 0 2px ' + C.sidebar,
          }}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 360, maxWidth: '92vw',
          background: C.card, border: `1px solid ${C.borderStrong}`, borderRadius: R.lg,
          boxShadow: '0 16px 40px rgba(0,0,0,0.5)', zIndex: 1200, overflow: 'hidden',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '11px 14px', borderBottom: `1px solid ${C.border}`,
          }}>
            <span style={{ fontWeight: 700, color: C.text, fontSize: 13.5 }}>
              Notifications{unread > 0 ? ` · ${unread} new` : ''}
            </span>
            <button onClick={markAllRead} disabled={unread === 0} style={{
              background: 'none', border: 'none', color: unread ? C.accent : C.textDim,
              cursor: unread ? 'pointer' : 'default', fontSize: 11.5, fontWeight: 600,
            }}>Mark all read</button>
          </div>

          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            {loading && items.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', color: C.textMuted, fontSize: 13 }}>Loading…</div>
            ) : items.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: C.textMuted, fontSize: 13 }}>
                🔕 No notifications yet.
              </div>
            ) : items.map(n => (
              <div
                key={n.id}
                onClick={() => !n.read && markRead(n.id)}
                style={{
                  display: 'flex', gap: 10, padding: '11px 14px',
                  borderBottom: `1px solid ${C.border}`, cursor: n.read ? 'default' : 'pointer',
                  background: n.read ? 'transparent' : 'rgba(249,115,22,0.05)',
                }}
              >
                <span style={{ fontSize: 16, lineHeight: 1.3 }}>{ICONS[n.type] || '🔔'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: C.text, fontSize: 13, fontWeight: n.read ? 500 : 700 }}>
                    {n.title || 'Notification'}
                  </div>
                  {n.body && (
                    <div style={{ color: C.textMuted, fontSize: 12, marginTop: 2, lineHeight: 1.45 }}>{n.body}</div>
                  )}
                  <div style={{ color: C.textDim, fontSize: 10.5, marginTop: 4, fontFamily: MONO }}>
                    {timeAgo(n.created_at)}
                  </div>
                </div>
                {!n.read && (
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.accent, marginTop: 5, flexShrink: 0 }} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
