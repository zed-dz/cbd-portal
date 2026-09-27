import { useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, MONO } from '../../theme';
import { Spinner } from '../index';

// Compact activity feed (Dashpivot parity X1). Renders activity_events rows as
// "<actor> <verb> <object> · <name> — <when>", newest first. Frameless on
// purpose — the page that embeds it decides on the card / tab chrome.
//
//   <ActivityFeed limit={15} />                 site-wide (Dashboard)
//   <ActivityFeed clientId={id} limit={30} />   one client (Clients page tab)

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' });
}

const VERB_COLORS = {
  created: C.success,
  applied: C.success,
  imported: C.info,
  duplicated: C.info,
  updated: C.warning,
  restored: C.success,
  archived: C.textMuted,
  deleted: C.error,
};

export function ActivityFeed({ clientId = null, siteId = null, limit = 15 }) {
  const [rows, setRows] = useState(null); // null = loading

  useEffect(() => {
    let mounted = true;
    (async () => {
      let q = supabase.from('activity_events')
        .select('id, actor_name, verb, object_type, object_id, client_id, site_id, after, before, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (clientId) q = q.eq('client_id', clientId);
      if (siteId) q = q.eq('site_id', siteId);
      const { data } = await q;
      if (mounted) setRows(data || []);
    })();
    return () => { mounted = false; };
  }, [clientId, siteId, limit]);

  if (rows === null) return <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}><Spinner /></div>;
  if (!rows.length) {
    return (
      <div style={{ color: C.textMuted, fontSize: 12, padding: '10px 0' }}>
        No activity recorded yet — events appear here as clients and rates are changed.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map(r => {
        const name = r.after?.name || r.before?.name || '';
        return (
          <div key={r.id} style={{
            display: 'flex', alignItems: 'baseline', gap: 8, padding: '7px 2px',
            borderBottom: `1px solid ${C.border}`, fontSize: 12.5, flexWrap: 'wrap',
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: 999, flexShrink: 0, alignSelf: 'center',
              background: VERB_COLORS[r.verb] || C.textDim,
            }} />
            <span style={{ color: C.text, minWidth: 0 }}>
              <strong>{r.actor_name || 'Someone'}</strong>
              <span style={{ color: C.textMuted }}> {r.verb} {r.object_type}</span>
              {name && <span style={{ color: C.text }}> · {name}</span>}
            </span>
            <span style={{ marginLeft: 'auto', color: C.textDim, fontSize: 10.5, fontFamily: MONO, whiteSpace: 'nowrap' }}>
              {timeAgo(r.created_at)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
