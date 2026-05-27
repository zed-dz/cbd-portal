import { useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, btnPrimary, btnSecondary } from '../../theme';
import { todayISO, fmtDate } from '../../utils/dates';
import { downloadCSV } from '../../utils/csv';
import { Spinner, allocationBadge, timesheetBadge } from '../../components';

export function DashboardPage({ showToast, currentWorker, onNavigate }) {
  const [stats, setStats] = useState(null);
  const [pendingTimesheets, setPendingTimesheets] = useState([]);
  const [expiredCerts, setExpiredCerts] = useState([]);
  const [todayAllocs, setTodayAllocs] = useState([]);
  const [dismissedAlerts, setDismissedAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const today = todayISO();
        const in30 = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
        const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
        const [onSite, available, pendingTs, licAlerts, weekHours, pendingList, expired, allocs, payrollReady] = await Promise.all([
          supabase.from('workers').select('id', { count: 'exact' }).eq('status', 'on_site').is('archived_at', null),
          supabase.from('workers').select('id', { count: 'exact' }).eq('status', 'available').is('archived_at', null),
          supabase.from('timesheets').select('id', { count: 'exact' }).eq('status', 'pending'),
          supabase.from('certifications').select('id', { count: 'exact' }).lt('expiry', in30),
          supabase.from('timesheets').select('hours').eq('status', 'approved').gte('date', weekAgo),
          supabase.from('timesheets').select('*, workers(name)').eq('status', 'pending').order('created_at', { ascending: false }).limit(5),
          supabase.from('certifications').select('*, workers(name)').lt('expiry', today),
          // Allocations that include today: start_date <= today AND
          // (end_date is null OR end_date >= today). Catches multi-day spans
          // that the previous `start_date = today` test missed.
          supabase.from('allocations').select('*, workers(name, job_title)').lte('start_date', today).or(`end_date.is.null,end_date.gte.${today}`).order('created_at', { ascending: false }),
          supabase.from('timesheets').select('id', { count: 'exact' }).eq('status', 'approved').eq('xero_exported', false),
        ]);
        if (!mounted) return;
        const totalWeekHrs = (weekHours.data || []).reduce((s, r) => s + (r.hours || 0), 0);
        setStats({
          onSite: onSite.count || 0,
          available: available.count || 0,
          pendingTs: pendingTs.count || 0,
          licAlerts: licAlerts.count || 0,
          weekHours: totalWeekHrs,
          payrollReady: payrollReady.count || 0,
        });
        setPendingTimesheets(pendingList.data || []);
        setExpiredCerts(expired.data || []);
        setTodayAllocs(allocs.data || []);
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [showToast]);

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}><Spinner size={36} /></div>;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = (currentWorker?.name || 'Admin').split(' ')[0];
  const dateLabel = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const visibleAlerts = expiredCerts.filter(c => !dismissedAlerts.includes(c.id));

  const statCards = [
    { label: 'On Site Today', value: stats?.onSite, color: C.accent, sub: null, onClick: () => onNavigate('workers') },
    { label: 'Available Pool', value: stats?.available, color: C.warning, sub: 'Not yet placed', onClick: () => onNavigate('workers') },
    { label: 'Awaiting Approval', value: stats?.pendingTs, color: C.error, sub: 'Timesheets pending', onClick: () => onNavigate('timesheets') },
    { label: 'Licence Alerts', value: stats?.licAlerts > 0 ? stats.licAlerts : '⚡', color: C.error, sub: 'See Licence Agent', onClick: () => onNavigate('licence_agent') },
    { label: 'Week Billing', value: stats?.weekHours > 0 ? `${stats.weekHours}h` : '✓', color: C.success, sub: 'See Payroll', onClick: () => onNavigate('payroll') },
    { label: 'Ready for Payroll', value: stats?.payrollReady || '✓', color: stats?.payrollReady > 0 ? '#13B5EA' : C.success, sub: stats?.payrollReady > 0 ? 'Approved, not sent' : 'All up to date', onClick: () => onNavigate('payroll') },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 4 }}>
        <div>
          <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 26, fontWeight: 700, color: C.text, letterSpacing: -0.4 }}>
            {greeting}, <span style={{ color: C.accent }}>{firstName}</span>
          </div>
          <div style={{ color: C.textMuted, fontSize: 12.5, marginTop: 4 }}>Operations overview · {dateLabel}</div>
        </div>
        <div style={{ fontSize: 10.5, color: C.textDim, textAlign: 'right', fontFamily: MONO, letterSpacing: 0.5, lineHeight: 1.6 }}>
          ABN: 75 663 693 070<br />Ops: Matt 0413 962 001
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        {statCards.map(sc => (
          <div key={sc.label}
            onClick={sc.onClick}
            onMouseEnter={e => { if (sc.onClick) { e.currentTarget.style.borderColor = C.borderStrong; e.currentTarget.style.transform = 'translateY(-1px)'; } }}
            onMouseLeave={e => { if (sc.onClick) { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.transform = 'translateY(0)'; } }}
            style={{
              background: C.card, border: `1px solid ${C.border}`,
              borderRadius: R.lg, padding: '16px 18px',
              cursor: sc.onClick ? 'pointer' : 'default',
              transition: 'border-color 140ms, transform 140ms',
            }}>
            <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 30, fontWeight: 800, color: sc.color, lineHeight: 1, letterSpacing: -0.5 }}>{sc.value ?? '—'}</div>
            <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1.4, color: C.textMuted, marginTop: 6, fontFamily: MONO, fontWeight: 600 }}>{sc.label}</div>
            {sc.sub && <div style={{ fontSize: 11, color: C.textDim, marginTop: 3 }}>{sc.sub}</div>}
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 11, padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13 }}>
            <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 14, fontWeight: 700, color: C.text }}>⚠ Urgent Alerts</div>
          </div>
          {visibleAlerts.length === 0 ? (
            <div style={{ color: C.textMuted, fontSize: 12, padding: '12px 0' }}>No profile alerts.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {visibleAlerts.slice(0, 4).map(c => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(239,68,68,0.07)', borderRadius: 7, padding: '8px 10px' }}>
                  <div>
                    <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{c.workers?.name || '—'}</span>
                    <span style={{ fontSize: 11, color: C.textMuted, marginLeft: 6 }}>{c.cert_name}</span>
                  </div>
                  <button onClick={() => setDismissedAlerts(d => [...d, c.id])} style={{ ...btnSecondary, padding: '2px 8px', fontSize: 11 }}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 11, padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13 }}>
            <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 14, fontWeight: 700, color: C.text }}>🕐 Pending Timesheets</div>
            <span style={{ background: 'rgba(249,115,22,0.15)', color: C.accent, padding: '2px 8px', borderRadius: 5, fontSize: 11, fontWeight: 600, fontFamily: '"DM Mono", monospace' }}>
              {stats?.pendingTs || 0}
            </span>
          </div>
          {pendingTimesheets.length === 0 ? (
            <div style={{ color: C.textMuted, fontSize: 12, padding: '12px 0' }}>No pending timesheets.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {pendingTimesheets.map(ts => (
                <div key={ts.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: C.bg, borderRadius: 7, padding: '8px 10px' }}>
                  <div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{ts.workers?.name || '—'}</span>
                    <span style={{ fontSize: 11, color: C.textMuted, marginLeft: 6 }}>{fmtDate(ts.date)} · {ts.hours}h</span>
                  </div>
                  {timesheetBadge(ts.status)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 11, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13 }}>
          <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 14, fontWeight: 700, color: C.text }}>📋 Today's Allocations</div>
          <div style={{ display: 'flex', gap: 7 }}>
            <button onClick={() => { const rows = todayAllocs.map(a => ({ worker: a.workers?.name || '', role: a.workers?.job_title || '', client: a.client || '', site: a.site || '', status: a.status })); downloadCSV(`allocations_today_${todayISO()}.csv`, rows.length ? rows : [{ note: 'No allocations today' }]); }} style={{ ...btnSecondary, padding: '5px 11px', fontSize: 11, fontWeight: 600 }}>📤 Export</button>
            <button onClick={() => onNavigate('allocations')} style={{ ...btnPrimary, padding: '5px 11px', fontSize: 11, fontWeight: 600 }}>Manage →</button>
          </div>
        </div>
        {todayAllocs.length === 0 ? (
          <div style={{ color: C.textMuted, fontSize: 12, padding: '8px 0' }}>No allocations scheduled for today.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 500 }}>
              <thead>
                <tr>
                  {['Worker', 'Role', 'Client', 'Site', 'Status'].map(h => (
                    <th key={h} style={{ textAlign: 'left', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1.5, color: C.textMuted, padding: '8px 12px', borderBottom: `1px solid ${C.border}`, fontFamily: '"DM Mono", monospace' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {todayAllocs.map(a => (
                  <tr key={a.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: '10px 12px', fontWeight: 600, fontSize: 13 }}>{a.workers?.name || '—'}</td>
                    <td style={{ padding: '10px 12px' }}>
                      {a.workers?.job_title ? (
                        <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 600, background: C.cardHover, color: C.textMuted, fontFamily: '"DM Mono", monospace' }}>{a.workers.job_title}</span>
                      ) : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 12, color: C.textMuted }}>{a.client || '—'}</td>
                    <td style={{ padding: '10px 12px', fontSize: 12, color: C.textMuted }}>{a.site || '—'}</td>
                    <td style={{ padding: '10px 12px' }}>{allocationBadge(a.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
