import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { C, R, MONO, btnPrimary, btnSecondary } from '../theme';
import { SendBlastModal } from '../components/blast/SendBlastModal';
import { ScanModal } from '../components/scan/ScanModal';
import { DashboardPage } from '../pages/Dashboard/DashboardPage';
import { WorkersPage } from '../pages/Workers/WorkersPage';
import { AllocationsPage } from '../pages/Allocations/AllocationsPage';
import { AllocationsCalendarPage } from '../pages/Calendar/AllocationsCalendarPage';
import { TimesheetsPage } from '../pages/Timesheets/TimesheetsPage';
import { ClientsPage } from '../pages/Clients/ClientsPage';
import { ClientApprovalsPage } from '../pages/ClientApprovals/ClientApprovalsPage';
import { PayrollTrackerPage } from '../pages/Payroll/PayrollTrackerPage';
import { PayrollConfigPage } from '../pages/Payroll/PayrollConfigPage';
import { XeroSyncPage } from '../pages/XeroSync/XeroSyncPage';
import { PaymentsPage } from '../pages/Payments/PaymentsPage';
import { LicenceAgentPage } from '../pages/LicenceAgent/LicenceAgentPage';
import { ReportsPage } from '../pages/Reports/ReportsPage';
import { BulkMessagesPage } from '../pages/BulkMessages/BulkMessagesPage';
import { InboxPage } from '../pages/Inbox/InboxPage';
import { TemplatesPage } from '../pages/Templates/TemplatesPage';
import { AppViewsPage } from '../pages/AppViews/AppViewsPage';
import { PendingWorkersPage } from '../pages/PendingWorkers/PendingWorkersPage';
import { ApplicationsPage } from '../pages/Applications/ApplicationsPage';
import { WorkerPortal } from './WorkerPortal';

export function AdminPortal({ currentWorker, onSignOut, showToast, isMobile, sidebarOpen, setSidebarOpen }) {
  // Land on Inbox if we just completed Gmail OAuth — the InboxPage will then
  // pick up the `gmail_connected=1` query param and show the toast.
  const initialPage = (() => {
    if (typeof window === 'undefined') return 'dashboard';
    const p = new URLSearchParams(window.location.search);
    if (p.get('gmail_connected') === '1' || p.get('gmail_error')) return 'inbox';
    return 'dashboard';
  })();
  const [activePage, setActivePage] = useState(initialPage);
  const [previewMode, setPreviewMode] = useState(false);
  const [blastOpen, setBlastOpen] = useState(false);
  const [scanOpen, setScanOpen]   = useState(false);
  const [badges, setBadges] = useState({ workers: 0, allocations: 0, timesheets: 0, client_approvals: 0, licence_agent: 0, pending_workers: 0, payroll: 0, applications: 0 });

  const refreshBadge = useCallback(async () => {
    const [w, a, ts, ca, lic, pw, pr, ap] = await Promise.all([
      supabase.from('workers').select('*', { count: 'exact', head: true }).is('archived_at', null),
      supabase.from('allocations').select('*', { count: 'exact', head: true }).in('status', ['pending', 'confirmed']),
      supabase.from('timesheets').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('timesheets').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('certifications').select('*', { count: 'exact', head: true }).lt('expiry', new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]),
      supabase.from('workers').select('*', { count: 'exact', head: true }).neq('app_status', 'Active').is('archived_at', null),
      supabase.from('timesheets').select('*', { count: 'exact', head: true }).eq('status', 'approved').eq('xero_exported', false),
      supabase.from('worker_applications').select('*', { count: 'exact', head: true }).eq('status', 'new'),
    ]);
    setBadges({
      workers: w.count || 0,
      allocations: a.count || 0,
      timesheets: ts.count || 0,
      client_approvals: ca.count || 0,
      licence_agent: lic.count || 0,
      pending_workers: pw.count || 0,
      payroll: pr.count || 0,
      applications: ap.count || 0,
    });
  }, []);

  useEffect(() => { refreshBadge(); }, [refreshBadge]);

  // Cross-page navigation event: components nested deep (e.g. an email-history
  // panel inside a worker/client modal) dispatch `cbd:navigate` to jump to a
  // page without prop-drilling. Currently used by EmailHistoryPanel → Inbox.
  useEffect(() => {
    const onNav = (e) => {
      const page = e?.detail?.page;
      if (page) setActivePage(page);
    };
    window.addEventListener('cbd:navigate', onNav);
    return () => window.removeEventListener('cbd:navigate', onNav);
  }, []);

  const BADGE_COLORS = {
    green: { bg: '#22c55e', text: '#fff' },
    orange: { bg: '#f97316', text: '#fff' },
    red: { bg: '#ef4444', text: '#fff' },
    yellow: { bg: '#eab308', text: '#fff' },
  };

  const navSections = [
    {
      label: 'MAIN',
      items: [
        { id: 'dashboard', label: '📊 Dashboard' },
        { id: 'workers', label: '👷 Workers', badge: badges.workers || null, badgeColor: 'green' },
        { id: 'allocations', label: '📋 Allocations', badge: badges.allocations || null, badgeColor: 'orange' },
        { id: 'calendar', label: '📅 Calendar' },
        { id: 'timesheets', label: '🕐 Timesheets', badge: badges.timesheets || null, badgeColor: 'red' },
        { id: 'client_approvals', label: '✅ Client Approvals', badge: badges.client_approvals || null, badgeColor: 'yellow' },
      ],
    },
    {
      label: 'FINANCE',
      items: [
        { id: 'clients', label: '🏗 Clients & Rates' },
        { id: 'payroll', label: '💰 Payroll', badge: badges.payroll || null, badgeColor: 'green' },
        { id: 'payments', label: '💳 Payments' },
        { id: 'payroll_config', label: '⚙ Payroll Config' },
        { id: 'xero_sync', label: '🔄 Xero Data' },
      ],
    },
    {
      label: 'TOOLS',
      items: [
        { id: 'inbox',         label: '📨 Inbox' },
        { id: 'templates',     label: '📝 Email Templates' },
        { id: 'bulk_messages', label: '📢 Bulk Messages' },
        { id: 'licence_agent', label: '🪪 Licence Agent', badge: badges.licence_agent || null, badgeColor: 'red' },
        { id: 'applications', label: '📥 Applications', badge: badges.applications || null, badgeColor: 'orange' },
        { id: 'pending_workers', label: '📱 Pending Workers', badge: badges.pending_workers || null, badgeColor: 'yellow' },
        { id: 'app_views', label: '📲 App Views' },
        { id: 'reports', label: '📁 Reports' },
      ],
    },
  ];

  const navigate = (id) => { setActivePage(id); if (isMobile) setSidebarOpen(false); };

  const sidebar = (
    <div style={{
      width: C.sidebarW, background: C.sidebar, height: '100vh', display: 'flex',
      flexDirection: 'column', borderRight: `1px solid ${C.border}`, flexShrink: 0, overflowY: 'auto',
      ...(isMobile ? { position: 'fixed', top: 0, left: 0, zIndex: 500, transform: sidebarOpen ? 'translateX(0)' : `translateX(-${C.sidebarW}px)`, transition: 'transform 0.25s ease', boxShadow: sidebarOpen ? '8px 0 32px rgba(0,0,0,0.5)' : 'none' } : {}),
    }}>
      <div style={{ padding: '22px 18px 18px', borderBottom: `1px solid ${C.border}`, marginBottom: 14 }}>
        <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 28, fontWeight: 800, color: C.accent, lineHeight: 1, letterSpacing: -0.5 }}>CBD</div>
        <div style={{ fontSize: 9, color: C.textMuted, fontFamily: MONO, letterSpacing: 2.2, textTransform: 'uppercase', marginTop: 4, fontWeight: 600 }}>Operations Portal</div>
      </div>
      <nav style={{ flex: 1, padding: '0 10px' }}>
        {navSections.map(section => (
          <div key={section.label} style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 9, letterSpacing: 2.2, textTransform: 'uppercase', color: C.textDim, padding: '0 10px', marginBottom: 6, fontFamily: MONO, fontWeight: 700 }}>{section.label}</div>
            {section.items.map(item => {
              const active = activePage === item.id;
              const bc = item.badgeColor ? BADGE_COLORS[item.badgeColor] : null;
              return (
                <button
                  key={item.id}
                  onClick={() => navigate(item.id)}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.background = C.cardHover; }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                  style={{
                    width: '100%', textAlign: 'left',
                    background: active ? C.cardHover : 'transparent',
                    color: active ? C.text : C.textMuted, border: 'none',
                    borderLeft: `3px solid ${active ? C.accent : 'transparent'}`,
                    borderRadius: `0 ${R.md}px ${R.md}px 0`,
                    padding: '8px 11px', cursor: 'pointer',
                    fontSize: 13, fontWeight: active ? 600 : 500,
                    marginBottom: 2, transition: 'all 120ms',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                  <span style={{ flex: 1 }}>{item.label}</span>
                  {item.badge && bc ? (
                    <span style={{ background: bc.bg, color: bc.text, borderRadius: R.pill, fontSize: 10, fontWeight: 700, padding: '1px 7px', fontFamily: MONO, minWidth: 18, textAlign: 'center' }}>
                      {item.badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <div style={{ padding: '12px 14px', background: C.bg, borderTop: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 9, color: C.textDim, marginBottom: 5, fontFamily: MONO, textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700 }}>Signed In</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-block', width: 7, height: 7, background: C.success, borderRadius: '50%', boxShadow: '0 0 6px rgba(34,197,94,0.6)' }} />
          <strong style={{ fontSize: 12.5, color: C.text }}>{currentWorker?.name}</strong>
        </div>
        <div style={{ fontSize: 9, color: C.textDim, marginTop: 3, fontFamily: MONO, letterSpacing: 1.2 }}>ROAD · RAIL · WATER</div>
        <button onClick={onSignOut} style={{ marginTop: 10, background: 'transparent', border: `1px solid ${C.border}`, color: C.textMuted, borderRadius: R.sm, padding: '5px 10px', fontSize: 10.5, cursor: 'pointer', fontFamily: MONO, width: '100%', letterSpacing: 0.5, transition: 'all 120ms' }}
          onMouseEnter={e => { e.currentTarget.style.color = C.text; e.currentTarget.style.borderColor = C.borderStrong; }}
          onMouseLeave={e => { e.currentTarget.style.color = C.textMuted; e.currentTarget.style.borderColor = C.border; }}
        >
          Sign out →
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', height: '100vh', background: C.bg }}>
      {!isMobile && sidebar}
      {isMobile && sidebarOpen && (
        <>
          {sidebar}
          <div onClick={() => setSidebarOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 499 }} />
        </>
      )}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ background: C.sidebar, borderBottom: `1px solid ${C.border}`, padding: '0 20px', height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {isMobile && (
              <button onClick={() => setSidebarOpen(o => !o)} style={{ background: 'none', border: 'none', color: C.text, cursor: 'pointer', fontSize: 22, lineHeight: 1, padding: 4 }} aria-label="Toggle menu">☰</button>
            )}
            <span style={{ fontSize: 10, color: C.textDim, fontFamily: MONO, letterSpacing: 1, fontWeight: 600 }}>CBD PLANT & LABOUR · ABN 75 663 693 070</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setPreviewMode(true)} style={{ ...btnSecondary, padding: '6px 13px', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>👁 Worker View</button>
            <button onClick={() => setScanOpen(true)} style={{ ...btnSecondary, padding: '6px 13px', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>📷 Scan</button>
            <button onClick={() => setBlastOpen(true)} style={{ ...btnPrimary, padding: '6px 13px', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>📢 Send Blast</button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? 12 : 24 }}>
          {activePage === 'dashboard'        && <DashboardPage showToast={showToast} currentWorker={currentWorker} onNavigate={navigate} />}
          {activePage === 'workers'          && <WorkersPage showToast={showToast} />}
          {activePage === 'allocations'      && <AllocationsPage showToast={showToast} />}
          {activePage === 'calendar'         && <AllocationsCalendarPage showToast={showToast} />}
          {activePage === 'pending_workers'  && <PendingWorkersPage showToast={showToast} />}
          {activePage === 'applications'     && <ApplicationsPage    showToast={showToast} onNavigate={navigate} />}
          {activePage === 'timesheets'       && <TimesheetsPage showToast={showToast} isMobile={isMobile} refreshBadge={refreshBadge} />}
          {activePage === 'clients'          && <ClientsPage showToast={showToast} />}
          {activePage === 'client_approvals' && <ClientApprovalsPage showToast={showToast} />}
          {activePage === 'payroll'          && <PayrollTrackerPage showToast={showToast} />}
          {activePage === 'payments'         && <PaymentsPage showToast={showToast} />}
          {activePage === 'payroll_config'   && <PayrollConfigPage showToast={showToast} />}
          {activePage === 'xero_sync'        && <XeroSyncPage showToast={showToast} />}
          {activePage === 'licence_agent'    && <LicenceAgentPage showToast={showToast} />}
          {activePage === 'reports'          && <ReportsPage showToast={showToast} />}
          {activePage === 'bulk_messages'    && <BulkMessagesPage showToast={showToast} />}
          {activePage === 'inbox'            && <InboxPage         showToast={showToast} onNavigate={navigate} />}
          {activePage === 'templates'        && <TemplatesPage     showToast={showToast} />}
          {activePage === 'app_views'        && <AppViewsPage showToast={showToast} />}
        </div>
      </div>

      {blastOpen && <SendBlastModal onClose={() => setBlastOpen(false)} showToast={showToast} />}
      {scanOpen  && <ScanModal      onClose={() => setScanOpen(false)}  showToast={showToast} />}

      {/* ── Preview Worker View overlay ──────────────────────────────────── */}
      {previewMode && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: C.bg, display: 'flex', flexDirection: 'column' }}>
          <div style={{ background: '#1a1a2e', borderBottom: `2px solid ${C.accent}`, padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <span style={{ fontSize: 11, color: C.accent, fontFamily: '"DM Mono", monospace', fontWeight: 700, letterSpacing: 1 }}>PREVIEW MODE — Worker Portal</span>
            <span style={{ fontSize: 11, color: C.textMuted }}>Viewing as: {currentWorker?.name}</span>
            <button onClick={() => setPreviewMode(false)} style={{ ...btnPrimary, marginLeft: 'auto', padding: '5px 14px', fontSize: 12 }}>✕ Exit Preview</button>
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <WorkerPortal currentWorker={currentWorker} onSignOut={() => setPreviewMode(false)} showToast={showToast} isMobile={isMobile} />
          </div>
        </div>
      )}
    </div>
  );
}
