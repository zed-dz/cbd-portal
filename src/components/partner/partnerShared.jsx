// Small pieces shared by the partner portal and the admin Sales partners page.
import { C, R, MONO } from '../../theme';
import { Badge } from '../ui/Badge';
import { statusMeta, fmtMoney } from '../../utils/commission';
import { fmtDate, fmtDateTime } from '../../utils/dates';

export function ReferralStatusBadge({ status, size }) {
  const m = statusMeta(status);
  return <Badge label={m.label} color={m.color} size={size} />;
}

export function CommissionStatusBadge({ status }) {
  const map = { pending: 'yellow', approved: 'blue', paid: 'green', void: 'gray' };
  return <Badge label={status} color={map[status] || 'gray'} />;
}

// Stat card: label on top, big number, optional sub line. Phone: 2 per row.
export function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: R.lg, padding: '14px 14px 12px', minWidth: 0 }}>
      <div style={{ fontSize: 10, color: C.textDim, fontFamily: MONO, letterSpacing: 1.4, textTransform: 'uppercase', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent ? C.accent : C.text, marginTop: 6, fontFamily: MONO, letterSpacing: -0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
      {sub ? <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div> : null}
    </div>
  );
}

export function StatGrid({ children, cols = 2 }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 10 }}>{children}</div>;
}

export function Card({ children, style, onClick }) {
  return (
    <div onClick={onClick} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: R.lg, padding: 14, cursor: onClick ? 'pointer' : 'default', ...style }}>
      {children}
    </div>
  );
}

export function SectionTitle({ children, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, margin: '18px 0 10px' }}>
      <div style={{ fontSize: 11, color: C.textDim, fontFamily: MONO, letterSpacing: 1.6, textTransform: 'uppercase', fontWeight: 700 }}>{children}</div>
      {right}
    </div>
  );
}

// One key/value line — label left, value right, wraps on phone.
export function KV({ k, v }) {
  if (v == null || v === '') return null;
  return (
    <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
      <span style={{ color: C.textMuted, flexShrink: 0 }}>{k}</span>
      <span style={{ color: C.text, textAlign: 'right', wordBreak: 'break-word' }}>{v}</span>
    </div>
  );
}

// Status + note timeline for one referral.
export function ReferralTimeline({ events }) {
  if (!events?.length) return <div style={{ color: C.textDim, fontSize: 12, padding: '8px 0' }}>No updates yet.</div>;
  return (
    <div>
      {events.map(ev => (
        <div key={ev.id} style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: ev.kind === 'status' ? C.accent : C.borderStrong, marginTop: 6, flexShrink: 0 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {ev.kind === 'status' && <ReferralStatusBadge status={ev.to_status} size="sm" />}
              {ev.kind === 'note' && <Badge label="Note" color="blue" size="sm" />}
              {ev.kind === 'request_update' && <Badge label="Update requested" color="orange" size="sm" />}
              {ev.kind === 'placement' && <Badge label="Placement" color="purple" size="sm" />}
              {ev.kind === 'commission' && <Badge label="Commission" color="green" size="sm" />}
              <span style={{ fontSize: 11, color: C.textDim, fontFamily: MONO }}>{fmtDateTime(ev.created_at)}</span>
              {ev.actor_name && <span style={{ fontSize: 11, color: C.textDim }}>· {ev.actor_name}</span>}
              {ev.visible_to_partner === false && <Badge label="office only" color="gray" size="sm" />}
            </div>
            {ev.note && <div style={{ fontSize: 13, color: C.text, marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{ev.note}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

// Referral summary block (full form read-back) used by both portals.
export function ReferralFacts({ r, typeLabel, sourceLabel }) {
  return (
    <div>
      <KV k="Type" v={typeLabel} />
      <KV k="Contact" v={[r.contact_name, r.contact_phone, r.contact_email].filter(Boolean).join(' · ')} />
      <KV k="Site" v={r.site_address} />
      {r.map_link && <KV k="Map" v={<a href={r.map_link} target="_blank" rel="noreferrer">Open map ↗</a>} />}
      <KV k="Roles" v={[...(r.roles || []), r.roles_other].filter(Boolean).join(', ')} />
      <KV k="People" v={r.people_count} />
      <KV k="Start" v={r.start_date ? fmtDate(r.start_date) : null} />
      <KV k="Duration" v={r.duration_text} />
      <KV k="Shift pattern" v={r.shift_pattern} />
      <KV k="Requirements" v={r.special_requirements} />
      <KV k="Sourced via" v={sourceLabel} />
      <KV k="Notes" v={r.partner_notes} />
      {r.client_name_snapshot && <KV k="Linked client" v={[r.client_name_snapshot, r.site_name_snapshot].filter(Boolean).join(' — ')} />}
      {r.status === 'declined' && r.declined_reason && r.reason_visible && <KV k="Reason" v={r.declined_reason} />}
      {r.is_test && <KV k="Flag" v={<Badge label="TEST DATA" color="orange" size="sm" />} />}
    </div>
  );
}

export const money = fmtMoney;
