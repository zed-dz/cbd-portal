import { C } from '../../theme';

// The "job file" for one client site, shown to the office while it creates or
// edits an allocation (Chris, 2026-10-28: "a folder per client, a file per job,
// showing who the timesheets get emailed to and the supervisor name + number").
//
// Read-only on purpose: the data lives under Clients & Rates → Manage sites so
// there is exactly one place to change it. Workers never see this card — their
// allocation only carries the supervisor name and phone.

// The person who signs off hours: the contact ticked "approves timesheets",
// else the primary contact, else the first one on the site. Same order the
// send-signoff-request function uses, so what the office sees here is who
// actually gets the link.
export function pickSupervisor(contacts) {
  const list = contacts || [];
  return list.find(k => k.approves_timesheets) || list.find(k => k.is_primary) || list[0] || null;
}

// Where the approved PDF goes: the site's own list, else the client's default.
export function timesheetRecipients(site, client) {
  const own = (site?.timesheet_emails || []).filter(Boolean);
  if (own.length) return { emails: own, source: 'site' };
  const fallback = (client?.timesheet_emails || []).filter(Boolean);
  if (fallback.length) return { emails: fallback, source: 'client' };
  return { emails: [], source: null };
}

const row = { display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.45, marginTop: 6 };
const label = { color: C.textMuted, minWidth: 118, flexShrink: 0 };
const warn = { color: C.warning };

export default function JobFileCard({ site, client, contacts }) {
  if (!site) return null;
  const mine = (contacts || []).filter(k => k.site_id === site.id);
  const sup = pickSupervisor(mine);
  const others = mine.filter(k => k !== sup);
  const to = timesheetRecipients(site, client);

  return (
    <div data-area="job file" style={{
      gridColumn: '1 / -1', background: C.bg, border: `1px solid ${C.border}`, borderLeft: `3px solid ${C.accent}`,
      borderRadius: 8, padding: '10px 12px', margin: '2px 0 10px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: C.text }}>
          📁 {client?.name || 'Client'} <span style={{ color: C.textMuted }}>›</span> {site.name}
        </div>
        <div style={{ fontSize: 11, color: C.textMuted }}>Job file · edit under Clients &amp; Rates → Manage sites</div>
      </div>

      <div style={row}>
        <span style={label}>Signs off hours</span>
        {sup ? (
          <span style={{ color: C.text }}>
            <strong>{sup.name}</strong>{sup.role ? ` · ${sup.role}` : ''}
            {sup.phone ? <> · <a href={`tel:${sup.phone}`} style={{ color: '#93c5fd', textDecoration: 'none' }}>{sup.phone}</a></> : <span style={warn}> · no phone</span>}
            {sup.email ? ` · ${sup.email}` : <span style={warn}> · no email (link goes by text only)</span>}
          </span>
        ) : (
          <span style={warn}>⚠ Nobody on file — the sign-off link cannot be sent. Add a contact and tick “Approves timesheets”.</span>
        )}
      </div>

      {others.length > 0 && (
        <div style={row}>
          <span style={label}>Other contacts</span>
          <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {others.map(k => (
              <span key={k.id} style={{ background: C.cardHover, border: `1px solid ${C.border}`, borderRadius: 999, padding: '1px 8px', fontSize: 11, color: C.text }}>
                {k.name}{k.role ? ` · ${k.role}` : ''}{k.phone ? ` · ${k.phone}` : ''}
              </span>
            ))}
          </span>
        </div>
      )}

      <div style={row}>
        <span style={label}>Approved PDFs go to</span>
        {to.emails.length ? (
          <span style={{ color: C.text }}>
            {to.emails.join(', ')}
            {to.source === 'client' && <span style={{ color: C.textMuted }}> (client default — no site list)</span>}
          </span>
        ) : (
          <span style={warn}>⚠ No address on file — approved timesheets will not send. Fill “Send approved timesheets to”.</span>
        )}
      </div>

      {(site.po_number || site.address) && (
        <div style={row}>
          <span style={label}>{site.po_number ? 'PO number' : 'Address'}</span>
          <span style={{ color: C.text }}>{site.po_number || site.address}{site.po_number && site.address ? ` · ${site.address}` : ''}</span>
        </div>
      )}

      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 8 }}>
        Workers never see this card. Their allocation shows only the supervisor name and phone.
      </div>
    </div>
  );
}
