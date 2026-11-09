// Sales Partner portal (2026-11-09). Rendered by App.jsx when the signed-in
// e-mail has no workers row but matches sales_partners.email.
// Pages: Home · Refer work · My referrals · Commission · Profile.
// Phone first: 360 px wide, 5 equal tabs, cards, no horizontal scroll.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient';
import { BRAND } from '../brand';
import { C, R, MONO, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../theme';
import { Spinner, Modal, Field, EmptyState, Badge, DateRangeFilter } from '../components';
import { ReferralForm } from '../components/partner/ReferralForm';
import { StatCard, StatGrid, Card, SectionTitle, KV, ReferralStatusBadge, CommissionStatusBadge, ReferralTimeline, ReferralFacts, money } from '../components/partner/partnerShared';
import { summarise, statementRows, COMMISSION_RULE_TEXT, REFERRAL_TYPES, SOURCE_OPTIONS, profileMissing, WON_STATUSES } from '../utils/commission';
import { downloadCSV } from '../utils/csv';
import { fmtDate, fmtDateTime } from '../utils/dates';
import { logActivity } from '../utils/activity';

const TABS = [
  { id: 'home',       label: 'Home',       icon: '🏠' },
  { id: 'refer',      label: 'Refer',      icon: '➕' },
  { id: 'referrals',  label: 'Referrals',  icon: '📋' },
  { id: 'commission', label: 'Commission', icon: '💰' },
  { id: 'profile',    label: 'Profile',    icon: '👤' },
];

export function PartnerPortal({ partner: initialPartner, onSignOut, showToast, isMobile }) {
  const [partner, setPartner] = useState(initialPartner);
  const [tab, setTab] = useState('home');
  const [data, setData] = useState({ referrals: [], events: [], placements: [], lines: [], notifications: [], bank: null, loading: true });
  const [openRef, setOpenRef] = useState(null);

  const reload = useCallback(async () => {
    const [p, r, ev, pl, ln, nt, bk] = await Promise.all([
      supabase.from('sales_partners').select('*').eq('id', initialPartner.id).maybeSingle(),
      supabase.from('partner_referrals').select('*').eq('partner_id', initialPartner.id).is('archived_at', null).order('created_at', { ascending: false }),
      supabase.from('partner_referral_events').select('*').order('created_at', { ascending: true }),
      supabase.from('partner_placements').select('*').eq('partner_id', initialPartner.id).order('period_start', { ascending: false }),
      supabase.from('partner_commission_lines').select('*').eq('partner_id', initialPartner.id).order('created_at', { ascending: false }),
      supabase.from('partner_notifications').select('*').eq('partner_id', initialPartner.id).order('created_at', { ascending: false }).limit(30),
      supabase.from('sales_partner_bank').select('*').eq('partner_id', initialPartner.id).maybeSingle(),
    ]);
    const err = [p, r, ev, pl, ln, nt, bk].find(x => x.error)?.error;
    if (err) showToast(`Could not load: ${err.message}`, 'error');
    if (p.data) setPartner(p.data);
    setData({ referrals: r.data || [], events: ev.data || [], placements: pl.data || [], lines: ln.data || [], notifications: nt.data || [], bank: bk.data || null, loading: false });
  }, [initialPartner.id, showToast]);

  useEffect(() => { reload(); }, [reload]);

  // First login: the profile must be complete before anything else (spec 4).
  const missing = useMemo(() => profileMissing(partner, data.bank), [partner, data.bank]);
  const locked = !data.loading && missing.length > 0;
  useEffect(() => { if (locked) setTab('profile'); }, [locked]);

  useEffect(() => {
    const prev = window.__portalLayout;
    window.__portalLayout = { portal: 'sales partner', device: isMobile ? 'phone' : 'desktop', menu: 'five tabs along the top, under the header', tabs: TABS.map(t => `${t.icon} ${t.label}`), sign_out: '"Sign out" button in the header at the top-right' };
    return () => { window.__portalLayout = prev; };
  }, [isMobile]);

  const unread = data.notifications.filter(n => !n.read).length;
  const pad = isMobile ? 12 : 24;

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: `0 ${pad}px`, height: 56, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 18, fontWeight: 800, color: C.accent, lineHeight: 1, letterSpacing: -0.3 }}>{BRAND.shortName}</div>
          <div style={{ fontSize: 9, color: C.textMuted, fontFamily: MONO, letterSpacing: 1.8, textTransform: 'uppercase', marginTop: 3, fontWeight: 600 }}>Sales partner</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ color: C.textMuted, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: isMobile ? 120 : 260 }}>{partner.name}</span>
          <button onClick={onSignOut} style={{ ...btnSecondary, padding: '6px 12px', fontSize: 12, whiteSpace: 'nowrap' }}>Sign out</button>
        </div>
      </div>

      <div data-area="partner tabs" style={{ background: C.card, borderBottom: `1px solid ${C.border}`, display: 'flex' }}>
        {TABS.map(t => {
          const on = tab === t.id;
          const dis = locked && t.id !== 'profile';
          return (
            <button key={t.id} onClick={() => !dis && setTab(t.id)} disabled={dis} aria-label={t.label} style={{
              flex: 1, minWidth: 0, padding: isMobile ? '9px 2px 8px' : '12px 10px', background: 'none', border: 'none', cursor: dis ? 'not-allowed' : 'pointer',
              color: on ? C.accent : C.textMuted, fontSize: isMobile ? 11 : 13, fontWeight: on ? 700 : 500,
              borderBottom: `2px solid ${on ? C.accent : 'transparent'}`, display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: 'center', justifyContent: 'center', gap: isMobile ? 2 : 6, position: 'relative',
            }}>
              <span style={{ fontSize: isMobile ? 16 : 14, lineHeight: 1 }}>{t.icon}</span>
              <span style={{ whiteSpace: 'nowrap' }}>{t.label}</span>
              {t.id === 'home' && unread > 0 && <span style={{ position: 'absolute', top: 6, right: isMobile ? 8 : 4, background: C.accent, color: '#fff', borderRadius: R.pill, fontSize: 9, fontWeight: 700, padding: '1px 5px', fontFamily: MONO }}>{unread}</span>}
            </button>
          );
        })}
      </div>

      <div style={{ padding: pad, maxWidth: 920, margin: '0 auto' }}>
        {data.loading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={32} /></div> : (
          <>
            {locked && (
              <div data-area="profile lock" style={{ background: C.warningSoft, border: '1px solid rgba(234,179,8,0.35)', borderRadius: R.md, padding: '10px 12px', fontSize: 13, color: '#fde68a', marginBottom: 14 }}>
                Finish your profile first — ABN, phone and bank details for payouts.
              </div>
            )}
            {tab === 'home'       && <Home partner={partner} data={data} isMobile={isMobile} go={setTab} openRef={setOpenRef} reload={reload} />}
            {tab === 'refer'      && <ReferralForm partner={partner} showToast={showToast} onSubmitted={(row, where) => { reload(); if (where === 'view') setTab('referrals'); }} />}
            {tab === 'referrals'  && <MyReferrals data={data} openRef={setOpenRef} go={setTab} />}
            {tab === 'commission' && <Commission partner={partner} data={data} isMobile={isMobile} showToast={showToast} />}
            {tab === 'profile'    && <Profile partner={partner} bank={data.bank} missing={missing} showToast={showToast} onSaved={reload} />}
          </>
        )}
      </div>

      {openRef && <ReferralDetail referral={data.referrals.find(r => r.id === openRef) || null} events={data.events.filter(e => e.referral_id === openRef)}
        placements={data.placements.filter(p => p.referral_id === openRef)} lines={data.lines} onClose={() => setOpenRef(null)} showToast={showToast} reload={reload} partner={partner} />}
    </div>
  );
}

// ── Home ─────────────────────────────────────────────────────────────────────
function Home({ partner, data, go, openRef, reload }) {
  const s = useMemo(() => summarise(data), [data]);
  const feed = useMemo(() => {
    const items = [
      ...data.notifications.map(n => ({ id: `n${n.id}`, at: n.created_at, text: n.title, sub: n.body, referral_id: n.referral_id, read: n.read })),
      ...data.events.filter(e => e.kind === 'status').map(e => ({ id: `e${e.id}`, at: e.created_at, text: `${data.referrals.find(r => r.id === e.referral_id)?.company_name || 'Referral'} → ${e.to_status?.replace(/_/g, ' ')}`, referral_id: e.referral_id, read: true })),
    ];
    return items.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 12);
  }, [data]);

  async function markRead() {
    const ids = data.notifications.filter(n => !n.read).map(n => n.id);
    if (!ids.length) return;
    await supabase.from('partner_notifications').update({ read: true }).in('id', ids);
    reload();
  }

  return (
    <div data-area="partner home">
      <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 12 }}>Hi {partner.name.split(/\s+/)[0]}</div>
      <StatGrid>
        <StatCard label="Referrals · month" value={s.referrals_this_month} sub={`${s.referrals_total} all time`} />
        <StatCard label="Active placements" value={s.active_placements} sub={`${data.referrals.filter(r => WON_STATUSES.includes(r.status)).length} won`} />
        <StatCard label="Commission due" value={money(s.pending_commission)} sub={s.approved_commission ? `${money(s.approved_commission)} approved` : 'waiting on the office'} accent />
        <StatCard label="Paid · YTD" value={money(s.paid_ytd)} sub={`${money(s.paid_lifetime)} lifetime`} />
      </StatGrid>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginTop: 14 }}>
        <button onClick={() => go('refer')} style={{ ...btnPrimary, padding: '12px 6px', fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>➕ Refer work</button>
        <button onClick={() => go('referrals')} style={{ ...btnSecondary, padding: '12px 6px', fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>📋 Referrals</button>
        <button onClick={() => go('commission')} style={{ ...btnSecondary, padding: '12px 6px', fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>💰 Statement</button>
      </div>
      <SectionTitle right={data.notifications.some(n => !n.read) && <button style={btnSmall} onClick={markRead}>Mark all read</button>}>Recent activity</SectionTitle>
      {feed.length === 0 ? <EmptyState icon="🕊" message="Nothing yet. Your first referral will show up here." /> : (
        <Card style={{ padding: '4px 14px' }}>
          {feed.map(f => (
            <div key={f.id} onClick={() => f.referral_id && openRef(f.referral_id)} style={{ display: 'flex', gap: 10, padding: '9px 0', borderBottom: `1px solid ${C.border}`, cursor: f.referral_id ? 'pointer' : 'default', alignItems: 'flex-start' }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: f.read ? C.border : C.accent, marginTop: 6, flexShrink: 0 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, color: C.text, wordBreak: 'break-word' }}>{f.text}</div>
                {f.sub && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2, wordBreak: 'break-word' }}>{f.sub}</div>}
              </div>
              <div style={{ fontSize: 10.5, color: C.textDim, fontFamily: MONO, whiteSpace: 'nowrap' }}>{fmtDate(f.at)}</div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// ── My referrals ─────────────────────────────────────────────────────────────
function MyReferrals({ data, openRef, go }) {
  const [filter, setFilter] = useState('all');
  const list = data.referrals.filter(r => filter === 'all' ? true : filter === 'open' ? !['completed', 'declined', 'duplicate'].includes(r.status) : ['completed', 'declined', 'duplicate'].includes(r.status));
  const segBtn = (on) => ({ ...btnSmall, borderRadius: R.pill, background: on ? C.accentSoft : C.cardHover, borderColor: on ? C.accentBorder : C.border, color: on ? C.text : C.textMuted });
  return (
    <div data-area="my referrals">
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        {[['all', 'All'], ['open', 'Open'], ['closed', 'Closed']].map(([id, l]) => <button key={id} style={segBtn(filter === id)} onClick={() => setFilter(id)}>{l}</button>)}
        <span style={{ flex: 1 }} />
        <button style={btnPrimary} onClick={() => go('refer')}>➕ Refer work</button>
      </div>
      {list.length === 0 ? <EmptyState icon="📋" message="No referrals here yet." action={<button style={btnPrimary} onClick={() => go('refer')}>Refer work</button>} /> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {list.map(r => (
            <Card key={r.id} onClick={() => openRef(r.id)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.company_name}{r.is_test ? ' · TEST' : ''}</div>
                  <div style={{ fontSize: 12, color: C.textMuted, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {[...(r.roles || []), r.roles_other].filter(Boolean).join(', ') || '—'} · {r.people_count} {r.people_count === 1 ? 'person' : 'people'}
                  </div>
                  <div style={{ fontSize: 11, color: C.textDim, marginTop: 3, fontFamily: MONO }}>{r.start_date ? `from ${fmtDate(r.start_date)}` : ''} · sent {fmtDate(r.created_at)}</div>
                </div>
                <ReferralStatusBadge status={r.status} />
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Referral detail (partner view) ──────────────────────────────────────────
function ReferralDetail({ referral: r, events, placements, lines, onClose, showToast, reload, partner }) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  if (!r) return null;
  const typeLabel = REFERRAL_TYPES.find(t => t.id === r.referral_type)?.label;
  const sourceLabel = SOURCE_OPTIONS.find(s => s.id === r.source)?.label;
  async function requestUpdate() {
    setAsking(true);
    const { error } = await supabase.from('partner_referral_events').insert([{ referral_id: r.id, kind: 'request_update', note: note.trim() || 'Can I have an update on this one?', visible_to_partner: true, actor_name: partner.name }]);
    setAsking(false);
    if (error) { showToast(error.message, 'error'); return; }
    logActivity({ verb: 'requested_update', object_type: 'partner_referral', object_id: r.id, actor_name: partner.name, after: { name: r.company_name } });
    showToast('Sent to the office.', 'success'); setNote(''); reload();
  }
  async function openAttachment() {
    const { data, error } = await supabase.storage.from('partner-referrals').createSignedUrl(r.attachment_path, 600);
    if (error || !data?.signedUrl) { showToast('Could not open the file.', 'error'); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  }
  const refLines = lines.filter(l => placements.some(p => p.id === l.placement_id) && l.status !== 'void');
  return (
    <Modal title={r.company_name} onClose={onClose} width={560} dismissible>
      <div data-area="referral detail">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <ReferralStatusBadge status={r.status} />
          <span style={{ fontSize: 11, color: C.textDim, fontFamily: MONO }}>sent {fmtDateTime(r.created_at)}</span>
          {r.attachment_path && <button style={btnSmall} onClick={openAttachment}>📎 Attachment</button>}
        </div>
        <ReferralFacts r={r} typeLabel={typeLabel} sourceLabel={sourceLabel} />
        {placements.length > 0 && (
          <>
            <SectionTitle>Work periods</SectionTitle>
            {placements.map(p => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, padding: '6px 0', borderBottom: `1px solid ${C.border}` }}>
                <span style={{ color: C.textMuted }}>{fmtDate(p.period_start)} → {fmtDate(p.period_end)}</span>
                <span style={{ fontFamily: MONO, color: C.text }}>{Number(p.hours || 0).toFixed(1)} h · {money(p.revenue_collected)} paid</span>
              </div>
            ))}
            {refLines.length > 0 && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 8 }}>Commission: {refLines.map(l => `${l.kind === 'bonus' ? 'bonus' : 'residual'} ${money(l.amount)} (${l.status})`).join(' · ')}</div>}
          </>
        )}
        <SectionTitle>Timeline</SectionTitle>
        <ReferralTimeline events={events} />
        <SectionTitle>Ask the office</SectionTitle>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={inputStyle} value={note} onChange={e => setNote(e.target.value)} placeholder="Request a status update…" />
          <button style={{ ...btnPrimary, whiteSpace: 'nowrap' }} disabled={asking} onClick={requestUpdate}>Send</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Commission ───────────────────────────────────────────────────────────────
function Commission({ partner, data, isMobile, showToast }) {
  const [range, setRange] = useState({ from: null, to: null });
  const s = useMemo(() => summarise(data), [data]);
  const placements = useMemo(() => data.placements.filter(p => (!range.from || p.period_end >= range.from) && (!range.to || p.period_start <= range.to)), [data.placements, range]);
  const lines = useMemo(() => data.lines.filter(l => l.status !== 'void' && placements.some(p => p.id === l.placement_id)), [data.lines, placements]);
  const rows = useMemo(() => statementRows({ lines, placements, referrals: data.referrals }), [lines, placements, data.referrals]);
  const refById = Object.fromEntries(data.referrals.map(r => [r.id, r]));

  const csv = () => { if (!rows.length) { showToast('Nothing to download for this range.', 'info'); return; } downloadCSV(`commission-statement-${partner.name.replace(/\W+/g, '-')}.csv`, rows); };
  const print = () => {
    const w = window.open('', '_blank');
    if (!w) { showToast('Allow pop-ups to print the statement.', 'error'); return; }
    const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const head = rows.length ? Object.keys(rows[0]) : [];
    const total = lines.reduce((a, l) => a + Number(l.amount || 0), 0);
    w.document.write(`<!doctype html><html><head><title>Commission statement</title><style>
      body{font-family:-apple-system,Segoe UI,sans-serif;color:#111;padding:28px;font-size:12px}h1{margin:0;font-size:20px}.sub{color:#555;margin:4px 0 18px}
      table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;font-size:11px}th{background:#f3f3f3;text-transform:uppercase;font-size:10px;letter-spacing:.5px}
      .tot{margin-top:14px;font-size:14px;font-weight:700}.rule{margin-top:22px;color:#444;font-size:11px}@media print{button{display:none}}</style></head><body>
      <h1>${esc(BRAND.fullName)} — Sales partner commission statement</h1>
      <div class="sub">${esc(partner.name)}${partner.company ? ' · ' + esc(partner.company) : ''}${partner.abn ? ' · ABN ' + esc(partner.abn) : ''} · ${range.from || range.to ? esc(`${range.from || '…'} → ${range.to || '…'}`) : 'all time'} · printed ${new Date().toLocaleDateString('en-AU')}</div>
      <table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${head.map(h => `<td>${esc(r[h])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${head.length || 1}">No commission lines in this range.</td></tr>`}</tbody></table>
      <div class="tot">Total commission in range: ${esc(money(total))}</div>
      <div class="rule"><strong>How commission works</strong><ul>${COMMISSION_RULE_TEXT.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      Your rates: first placement bonus ${esc(money(partner.first_placement_bonus))} · residual ${esc(partner.residual_pct_y1)}% year 1, ${esc(partner.residual_pct_y2)}% after.</div>
      <script>window.onload=function(){window.print()}</script></body></html>`);
    w.document.close();
  };

  return (
    <div data-area="commission">
      <StatGrid>
        <StatCard label="Pending" value={money(s.pending_commission)} sub="waiting on the office" accent />
        <StatCard label="Paid this month" value={money(s.paid_this_month)} />
        <StatCard label="Lifetime paid" value={money(s.paid_lifetime)} sub={`${money(s.paid_ytd)} this year`} />
        <StatCard label="Earning now" value={s.active_revenue_generating} sub="active referrals with work" />
      </StatGrid>
      <SectionTitle right={<div style={{ display: 'flex', gap: 6 }}><button style={btnSmall} onClick={csv}>⬇ CSV</button><button style={btnSmall} onClick={print} data-testid="print-statement">🖨 Statement</button></div>}>Placements</SectionTitle>
      <div style={{ marginBottom: 10 }}><DateRangeFilter from={range.from} to={range.to} onApply={setRange} /></div>
      {placements.length === 0 ? <EmptyState icon="💰" message="No work periods yet. When your referral goes Active and the client pays, periods and commission show here." /> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {placements.map(p => {
            const r = refById[p.referral_id] || {};
            const pl = data.lines.filter(l => l.placement_id === p.id && l.status !== 'void');
            return (
              <Card key={p.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.client_name_snapshot || r.company_name || '—'}</div>
                    <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{p.roles_text || (r.roles || []).join(', ') || '—'}</div>
                  </div>
                  <div style={{ fontSize: 11, color: C.textDim, fontFamily: MONO, whiteSpace: 'nowrap' }}>{fmtDate(p.period_start)} → {fmtDate(p.period_end)}</div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6, marginTop: 10, fontSize: 12 }}>
                  <div><div style={{ color: C.textDim, fontSize: 10, fontFamily: MONO, textTransform: 'uppercase', letterSpacing: 1 }}>Hours</div><div style={{ color: C.text, fontFamily: MONO }}>{Number(p.hours || 0).toFixed(1)}</div></div>
                  <div><div style={{ color: C.textDim, fontSize: 10, fontFamily: MONO, textTransform: 'uppercase', letterSpacing: 1 }}>Paid by client</div><div style={{ color: C.text, fontFamily: MONO }}>{money(p.revenue_collected)}</div></div>
                  <div><div style={{ color: C.textDim, fontSize: 10, fontFamily: MONO, textTransform: 'uppercase', letterSpacing: 1 }}>Gross margin</div><div style={{ color: C.text, fontFamily: MONO }}>{money(Number(p.revenue_collected || 0) - Number(p.cost || 0))}</div></div>
                </div>
                {pl.length > 0 && (
                  <div style={{ marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
                    {pl.map(l => (
                      <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13 }}>
                        <span style={{ color: C.textMuted, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.kind === 'bonus' ? 'First placement bonus' : `Residual ${Number(l.rate)}%`}</span>
                        <span style={{ display: 'flex', gap: 8, alignItems: 'center', whiteSpace: 'nowrap' }}>
                          <strong style={{ fontFamily: MONO, color: C.text }}>{money(l.amount)}</strong>
                          <CommissionStatusBadge status={l.status} />
                        </span>
                      </div>
                    ))}
                    {pl.some(l => l.status === 'paid') && <div style={{ fontSize: 11, color: C.textDim, fontFamily: MONO, marginTop: 4 }}>{pl.filter(l => l.status === 'paid').map(l => `paid ${fmtDate(l.paid_at)}${l.payment_ref ? ` · ref ${l.payment_ref}` : ''}`).join(' · ')}</div>}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
      <SectionTitle>How commission works</SectionTitle>
      <Card>
        {COMMISSION_RULE_TEXT.map((t, i) => <div key={i} style={{ fontSize: 13, color: C.textMuted, padding: '5px 0', display: 'flex', gap: 8 }}><span style={{ color: C.accent }}>•</span><span>{t}</span></div>)}
        <div style={{ marginTop: 8, fontSize: 12, color: C.text, fontFamily: MONO }}>Your rates: bonus {money(partner.first_placement_bonus)} · {Number(partner.residual_pct_y1)}% year 1 · {Number(partner.residual_pct_y2)}% after</div>
      </Card>
    </div>
  );
}

// ── Profile ──────────────────────────────────────────────────────────────────
function Profile({ partner, bank, missing, showToast, onSaved }) {
  const [f, setF] = useState({ name: partner.name || '', company: partner.company || '', abn: partner.abn || '', phone: partner.phone || '',
    notify_email: partner.notify_email !== false, notify_sms: partner.notify_sms === true, weekly_summary: partner.weekly_summary === true,
    account_name: bank?.account_name || '', bsb: bank?.bsb || '', account_no: bank?.account_no || '' });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const err = (k) => missing.includes(k) && !String(f[k] || '').trim() ? 'Required' : undefined;

  async function save(e) {
    e.preventDefault();
    const still = profileMissing({ phone: f.phone, abn: f.abn }, { account_name: f.account_name, bsb: f.bsb, account_no: f.account_no });
    if (still.length) { showToast(`Check: ${still.map(k => ({ phone: 'phone', abn: 'ABN (11 digits)', account_name: 'account name', bsb: 'BSB (6 digits)', account_no: 'account number' })[k]).join(', ')}.`, 'error'); return; }
    setBusy(true);
    const { error: e1 } = await supabase.from('sales_partners').update({ name: f.name.trim() || partner.name, company: f.company.trim() || null, abn: f.abn.replace(/\s/g, ''), phone: f.phone.trim(),
      notify_email: f.notify_email, notify_sms: f.notify_sms, weekly_summary: f.weekly_summary, profile_completed_at: partner.profile_completed_at || new Date().toISOString() }).eq('id', partner.id);
    const { error: e2 } = await supabase.from('sales_partner_bank').upsert([{ partner_id: partner.id, account_name: f.account_name.trim(), bsb: f.bsb.replace(/[\s-]/g, ''), account_no: f.account_no.replace(/\s/g, ''), updated_at: new Date().toISOString() }]);
    setBusy(false);
    if (e1 || e2) { showToast((e1 || e2).message, 'error'); return; }
    logActivity({ verb: 'updated', object_type: 'sales_partner_profile', object_id: partner.id, actor_name: partner.name, after: { name: f.name } });
    showToast('Profile saved.', 'success');
    onSaved?.();
  }
  const Toggle = ({ k, label }) => (
    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 0', borderBottom: `1px solid ${C.border}`, fontSize: 13, color: C.text, cursor: 'pointer' }}>
      <span>{label}</span><input type="checkbox" checked={!!f[k]} onChange={e => set(k, e.target.checked)} style={{ width: 18, height: 18 }} />
    </label>
  );
  return (
    <form onSubmit={save} data-area="partner profile">
      <SectionTitle>Contact</SectionTitle>
      <Card>
        <Field label="Name"><input style={inputStyle} value={f.name} onChange={e => set('name', e.target.value)} /></Field>
        <Field label="Company"><input style={inputStyle} value={f.company} onChange={e => set('company', e.target.value)} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
          <Field label="ABN *" error={err('abn')}><input style={inputStyle} value={f.abn} onChange={e => set('abn', e.target.value)} placeholder="11 digits" inputMode="numeric" /></Field>
          <Field label="Phone *" error={err('phone')}><input style={inputStyle} value={f.phone} onChange={e => set('phone', e.target.value)} placeholder="04xx xxx xxx" inputMode="tel" /></Field>
        </div>
        <KV k="Login email" v={partner.email} />
      </Card>
      <SectionTitle>Bank details for payouts</SectionTitle>
      <Card>
        <Field label="Account name *" error={err('account_name')}><input style={inputStyle} value={f.account_name} onChange={e => set('account_name', e.target.value)} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
          <Field label="BSB *" error={err('bsb')}><input style={inputStyle} value={f.bsb} onChange={e => set('bsb', e.target.value)} placeholder="000-000" inputMode="numeric" /></Field>
          <Field label="Account number *" error={err('account_no')}><input style={inputStyle} value={f.account_no} onChange={e => set('account_no', e.target.value)} inputMode="numeric" /></Field>
        </div>
        <div style={{ fontSize: 11, color: C.textDim }}>Only you and the finance admin can see these.</div>
      </Card>
      <SectionTitle>Notifications</SectionTitle>
      <Card style={{ padding: '2px 14px' }}>
        <Toggle k="notify_email" label="Email me on every status change and payment" />
        <Toggle k="notify_sms" label="Also text me (SMS)" />
        <Toggle k="weekly_summary" label="Monday weekly summary email" />
      </Card>
      <button type="submit" disabled={busy} style={{ ...btnPrimary, width: '100%', padding: '13px 18px', fontSize: 15, marginTop: 14 }}>{busy ? 'Saving…' : 'Save profile'}</button>
      <div style={{ marginTop: 10, textAlign: 'center' }}><Badge label={partner.status === 'active' ? 'Active partner' : partner.status} color={partner.status === 'active' ? 'green' : 'yellow'} /></div>
    </form>
  );
}
