import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { C, R, MONO, btnPrimary, btnSecondary } from '../theme';
import { SendBlastModal } from '../components/blast/SendBlastModal';
import { ScanModal } from '../components/scan/ScanModal';
import { NotificationBell } from '../components/notifications/NotificationBell';
import { NotificationSettings } from '../components/notifications/NotificationSettings';
import { MfaSettings, useMfaFactors } from '../components/security/MfaSettings';
import { DashboardPage } from '../pages/Dashboard/DashboardPage';
import { WorkersPage } from '../pages/Workers/WorkersPage';
import { RateSetsPage } from '../pages/RateSets/RateSetsPage';
import { SentTimesheetsPage } from '../pages/SentTimesheets/SentTimesheetsPage';
import { AllocationsPage } from '../pages/Allocations/AllocationsPage';
import { AllocationsCalendarPage } from '../pages/Calendar/AllocationsCalendarPage';
import { AllocationBoardPage } from '../pages/Allocations/AllocationBoardPage';
import { TimesheetsPage } from '../pages/Timesheets/TimesheetsPage';
import { localISO } from '../utils/dates';
import { ClientsPage } from '../pages/Clients/ClientsPage';
import { DefaultRatesPage } from '../pages/Clients/DefaultRatesPage';
import { PayrollTrackerPage } from '../pages/Payroll/PayrollTrackerPage';
import { PayrollConfigPage } from '../pages/Payroll/PayrollConfigPage';
import { XeroSyncPage } from '../pages/XeroSync/XeroSyncPage';
import { PaymentsPage } from '../pages/Payments/PaymentsPage';
import { LicenceAgentPage } from '../pages/LicenceAgent/LicenceAgentPage';
import { ReportsPage } from '../pages/Reports/ReportsPage';
import { PlantPage } from '../pages/Plant/PlantPage';
import { InvoicesPage } from '../pages/Invoices/InvoicesPage';
import { BulkMessagesPage } from '../pages/BulkMessages/BulkMessagesPage';
import { InboxPage } from '../pages/Inbox/InboxPage';
import { TemplatesPage } from '../pages/Templates/TemplatesPage';
import { AppViewsPage } from '../pages/AppViews/AppViewsPage';
import { PendingWorkersPage } from '../pages/PendingWorkers/PendingWorkersPage';
import { ApplicationsPage } from '../pages/Applications/ApplicationsPage';
import { LeaveRequestsPage } from '../pages/Leave/LeaveRequestsPage';
import { PoliciesPage } from '../pages/Policies/PoliciesPage';
import { VideoGuidePage } from '../pages/VideoGuide/VideoGuidePage';
import { ContractsPage } from '../pages/Contracts/ContractsPage';
import { IncidentsPage } from '../pages/Safety/IncidentsPage';
import { DocumentsPage } from '../pages/Documents/DocumentsPage';
import { WorkerPortal } from './WorkerPortal';
import { canSeeMoney } from '../utils/access';

export function AdminPortal({ currentWorker, onSignOut, showToast, isMobile, sidebarOpen, setSidebarOpen }) {
  // Land on Inbox if we just completed Gmail OAuth — the InboxPage will then
  // pick up the `gmail_connected=1` query param and show the toast.
  const initialPage = (() => {
    if (typeof window === 'undefined') return 'dashboard';
    const p = new URLSearchParams(window.location.search);
    if (p.get('gmail_connected') === '1' || p.get('gmail_error')) return 'inbox';
    return 'dashboard';
  })();
  const [contractPrompt, setContractPrompt] = useState(null);   // Add Worker → Contracts hand-off when specifics are missing
  const [activePage, setActivePage] = useState(initialPage);
  const [previewMode, setPreviewMode] = useState(false);
  const [blastOpen, setBlastOpen] = useState(false);
  const [scanOpen, setScanOpen]   = useState(false);
  const [notifSettingsOpen, setNotifSettingsOpen] = useState(false);
  const [mfaOpen, setMfaOpen] = useState(false);
  // Own two-step login status: admins without a factor get a one-line nudge
  // (no forced enrolment — the owner decides later).
  const mfa = useMfaFactors();
  const showMfaNudge = currentWorker?.access_level === 'admin' && mfa.verified === false;
  // Money screens: admin level and NOT an allocator (owner rule 2026-10-20).
  const isMoneyUser = canSeeMoney(currentWorker);
  // Allocation Board → "Allocate" hands the Allocations page a pre-ticked crew.
  const [allocPrefill, setAllocPrefill] = useState(null);
  const [badges, setBadges] = useState({ workers: 0, allocations: 0, timesheets: 0, licence_agent: 0, pending_workers: 0, payroll: 0, applications: 0, leave: 0, safety: 0 });

  const refreshBadge = useCallback(async () => {
    const [w, a, ts, lic, pw, pr, ap, lv, sf] = await Promise.all([
      supabase.from('workers').select('id', { count: 'exact', head: true }).is('archived_at', null),
      supabase.from('allocations').select('*', { count: 'exact', head: true }).in('status', ['pending', 'confirmed']),
      supabase.from('timesheets').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('certifications').select('*', { count: 'exact', head: true }).lt('expiry', localISO(new Date(Date.now() + 30 * 86400000))),
      supabase.from('workers').select('id', { count: 'exact', head: true }).neq('app_status', 'Active').is('archived_at', null),
      supabase.from('timesheets').select('*', { count: 'exact', head: true }).eq('status', 'approved').eq('xero_exported', false),
      supabase.from('worker_applications').select('*', { count: 'exact', head: true }).eq('status', 'new'),
      supabase.from('leave_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('incident_reports').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    ]);
    setBadges({
      workers: w.count || 0,
      allocations: a.count || 0,
      timesheets: ts.count || 0,
      licence_agent: lic.count || 0,
      pending_workers: pw.count || 0,
      payroll: pr.count || 0,
      applications: ap.count || 0,
      leave: lv.count || 0,
      safety: sf.count || 0,
    });
  }, []);

  useEffect(() => { refreshBadge(); }, [refreshBadge]);

  // The help bubble mounts at App level, outside this tree, so publish the
  // active page on window rather than prop-drilling it down.
  useEffect(() => { window.__portalPage = activePage; }, [activePage]);

  // Cross-page navigation event: components nested deep (e.g. an email-history
  // panel inside a worker/client modal) dispatch `cbd:navigate` to jump to a
  // page without prop-drilling. Currently used by EmailHistoryPanel → Inbox.
  useEffect(() => {
    const onNav = (e) => {
      const page = e?.detail?.page;
      if (page) setActivePage(page);
      if (e?.detail?.contract) setContractPrompt(e.detail.contract);
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
        { id: 'board', label: '🗓 Allocation Board' },
        { id: 'calendar', label: '📅 Calendar' },
        { id: 'timesheets', label: '🕐 Timesheets', badge: badges.timesheets || null, badgeColor: 'red' },
        { id: 'sent_timesheets', label: '📤 Sent Timesheets' },
        { id: 'leave', label: '🏖 Time off requests', badge: badges.leave || null, badgeColor: 'yellow' },
        { id: 'policies', label: '📚 Policies' },
        { id: 'video_guide', label: '🎬 Video guide' },
      ],
    },
    // Money pages are Admin-only (owner, 2026-09-27). Managers/allocators keep
    // MAIN + TOOLS; the DB enforces the same line with RLS, this just removes
    // the dead doors. Clients & Rates stays visible to managers for sites and
    // contacts — its rate panels are gated inside the page.
    ...(isMoneyUser ? [{
      label: 'FINANCE',
      items: [
        { id: 'clients', label: '🏗 Clients & Rates' },
        { id: 'rate_sets', label: '📚 Rate Sets' },
        { id: 'default_rates', label: '💲 Default Rates' },
        { id: 'payroll', label: '💰 Payroll', badge: badges.payroll || null, badgeColor: 'green' },
        { id: 'invoices', label: '🧾 Invoices' },
        { id: 'contracts', label: '📝 Contracts' },
        // Payments (Stripe) is hidden until its maths matches payroll/billing and
        // the Stripe keys are set (audit P2). Set REACT_APP_PAYMENTS_ENABLED=1 to show it.
        ...(process.env.REACT_APP_PAYMENTS_ENABLED === '1' ? [{ id: 'payments', label: '💳 Payments' }] : []),
        { id: 'payroll_config', label: '⚙ Payroll Config' },
        { id: 'xero_sync', label: '🔄 Xero Data' },
        { id: 'plant', label: '🚜 Plant' },
      ],
    }] : [{
      label: 'FINANCE',
      items: [
        { id: 'clients', label: '🏗 Clients & Sites' },
      ],
    }]),
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
        { id: 'safety', label: '🦺 Safety', badge: badges.safety || null, badgeColor: 'red' },
        { id: 'documents', label: '📄 Documents' },
        { id: 'reports', label: '📁 Reports' },
      ],
    },
  ];

  const navigate = (id) => { setActivePage(id); if (isMobile) setSidebarOpen(false); };

  // The Portal Assistant answers "where is X?" from this. It is built from the
  // same list the sidebar draws, so moving a menu item cannot leave it stale.
  // Keep sign_out in step with the Sign out button at the bottom of `sidebar`.
  const layoutKey = JSON.stringify(navSections.map(s => ({ section: s.label, items: s.items.map(i => i.label) })));
  useEffect(() => {
    window.__portalLayout = {
      portal: 'office',
      device: isMobile ? 'phone' : 'desktop',
      menu: JSON.parse(layoutKey),
      menu_location: isMobile
        ? 'hidden behind the ☰ button at the top-left of the screen; tap ☰ to slide the menu open'
        : 'always visible down the left side of the screen',
      sign_out: isMobile
        ? 'tap ☰ at the top-left, then "Sign out →" at the very bottom of the menu, under your name'
        : '"Sign out →" button at the very bottom of the left sidebar, under "Signed in" and your name',
    };
  }, [layoutKey, isMobile]);

  const sidebar = (
    <div data-area="left sidebar" style={{
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
        {isMobile && (
          /* Phones: the top bar has no room for a 6th button, so two-step login lives here. */
          <button onClick={() => { setSidebarOpen(false); setMfaOpen(true); }} data-area="two-step login button"
            style={{ marginTop: 10, background: 'transparent', border: `1px solid ${showMfaNudge ? 'rgba(245,158,11,0.55)' : C.border}`, color: showMfaNudge ? '#fcd34d' : C.text, borderRadius: R.sm, padding: '8px 10px', fontSize: 12, cursor: 'pointer', width: '100%', minHeight: 36, fontWeight: 600 }}>
            🔐 {showMfaNudge ? 'Add two-step login' : 'Two-step login'}
          </button>
        )}
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
        <div style={{ background: C.sidebar, borderBottom: `1px solid ${C.border}`, padding: isMobile ? '0 10px' : '0 20px', height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          {/* minWidth 0 lets the title ellipsize instead of pushing the buttons off a 360 px screen. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: '1 1 auto' }}>
            {isMobile && (
              <button onClick={() => setSidebarOpen(o => !o)} style={{ background: 'none', border: 'none', color: C.text, cursor: 'pointer', fontSize: 22, lineHeight: 1, padding: 4 }} aria-label="Toggle menu">☰</button>
            )}
            <span style={{ fontSize: 10, color: C.textDim, fontFamily: MONO, letterSpacing: 1, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{isMobile ? 'CBD PLANT & LABOUR' : 'CBD PLANT & LABOUR · ABN 75 663 693 070'}</span>
          </div>
          <div style={{ display: 'flex', gap: isMobile ? 5 : 8, alignItems: 'center', flexShrink: 0 }}>
            <NotificationBell />
            <button onClick={() => setNotifSettingsOpen(true)} title="Notification settings" style={{ background: 'transparent', border: `1px solid ${C.border}`, color: C.text, borderRadius: R.md, padding: '6px 10px', cursor: 'pointer', fontSize: 15, lineHeight: 1, display: 'inline-flex', alignItems: 'center' }}>⚙</button>
            {!isMobile && (
              <button onClick={() => setMfaOpen(true)} title={showMfaNudge ? 'Add two-step login' : 'Two-step login'} aria-label="Two-step login" data-area="two-step login button"
                style={{ background: 'transparent', border: `1px solid ${showMfaNudge ? 'rgba(245,158,11,0.55)' : C.border}`, color: C.text, borderRadius: R.md, padding: '6px 10px', cursor: 'pointer', fontSize: 13, lineHeight: 1, display: 'inline-flex', alignItems: 'center', gap: 6, position: 'relative' }}>
                🔐{showMfaNudge && <span style={{ fontSize: 11, color: '#fcd34d', fontWeight: 600, whiteSpace: 'nowrap' }}>Add two-step login</span>}
              </button>
            )}
            {/* Phones (360 px): icon-only buttons so the bar never scrolls sideways. */}
            <button onClick={() => setPreviewMode(true)} title="Worker View" aria-label="Worker View" style={{ ...btnSecondary, padding: isMobile ? '6px 9px' : '6px 13px', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>👁{!isMobile && ' Worker View'}</button>
            <button onClick={() => setScanOpen(true)} title="Scan" aria-label="Scan" style={{ ...btnSecondary, padding: isMobile ? '6px 9px' : '6px 13px', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>📷{!isMobile && ' Scan'}</button>
            <button onClick={() => setBlastOpen(true)} title="Send Blast" aria-label="Send Blast" style={{ ...btnPrimary, padding: isMobile ? '6px 9px' : '6px 13px', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>📢{!isMobile && ' Send Blast'}</button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? 12 : 24 }}>
          {activePage === 'dashboard'        && <DashboardPage showToast={showToast} currentWorker={currentWorker} onNavigate={navigate} />}
          {activePage === 'workers'          && <WorkersPage showToast={showToast} currentWorker={currentWorker} />}
          {activePage === 'allocations'      && <AllocationsPage showToast={showToast} prefill={allocPrefill} onPrefillUsed={() => setAllocPrefill(null)} />}
          {activePage === 'board'            && <AllocationBoardPage showToast={showToast} isMobile={isMobile} currentWorker={currentWorker}
                                                   onAllocate={(ids, date) => { setAllocPrefill({ workerIds: ids, date }); navigate('allocations'); }} />}
          {activePage === 'calendar'         && <AllocationsCalendarPage showToast={showToast} />}
          {activePage === 'pending_workers'  && <PendingWorkersPage showToast={showToast} />}
          {activePage === 'applications'     && <ApplicationsPage    showToast={showToast} onNavigate={navigate} />}
          {activePage === 'timesheets'       && <TimesheetsPage showToast={showToast} isMobile={isMobile} refreshBadge={refreshBadge} />}
          {activePage === 'clients'          && <ClientsPage showToast={showToast} currentWorker={currentWorker} />}
          {/* Money pages render for admin level only — the menu already hides
              them, this also shuts the side doors (cbd:navigate events, the help
              assistant). Office staff without money access (e.g. allocators)
              never see pay, rates or Xero. RLS enforces the same line. */}
          {activePage === 'rate_sets'        && isMoneyUser && <RateSetsPage showToast={showToast} />}
          {activePage === 'sent_timesheets'  && <SentTimesheetsPage showToast={showToast} />}
          {activePage === 'default_rates'    && isMoneyUser && <DefaultRatesPage showToast={showToast} />}
          {activePage === 'payroll'          && isMoneyUser && <PayrollTrackerPage showToast={showToast} />}
          {activePage === 'payments'         && isMoneyUser && <PaymentsPage showToast={showToast} />}
          {activePage === 'payroll_config'   && isMoneyUser && <PayrollConfigPage showToast={showToast} />}
          {activePage === 'xero_sync'        && isMoneyUser && <XeroSyncPage showToast={showToast} />}
          {activePage === 'licence_agent'    && <LicenceAgentPage showToast={showToast} />}
          {activePage === 'reports'          && <ReportsPage showToast={showToast} currentWorker={currentWorker} />}
          {activePage === 'plant'            && isMoneyUser && <PlantPage showToast={showToast} />}
          {activePage === 'invoices'         && isMoneyUser && <InvoicesPage showToast={showToast} />}
          {activePage === 'bulk_messages'    && <BulkMessagesPage showToast={showToast} />}
          {activePage === 'inbox'            && <InboxPage         showToast={showToast} onNavigate={navigate} />}
          {activePage === 'templates'        && <TemplatesPage     showToast={showToast} />}
          {activePage === 'app_views'        && <AppViewsPage showToast={showToast} />}
          {activePage === 'leave'            && <LeaveRequestsPage showToast={showToast} currentWorker={currentWorker} refreshBadge={refreshBadge} />}
          {activePage === 'policies'         && <PoliciesPage showToast={showToast} currentWorker={currentWorker} />}
          {activePage === 'video_guide'      && <VideoGuidePage showToast={showToast} currentWorker={currentWorker} />}
          {activePage === 'contracts'        && isMoneyUser && <ContractsPage showToast={showToast} currentWorker={currentWorker} openSendFor={contractPrompt} />}
          {activePage === 'safety'           && <IncidentsPage showToast={showToast} currentWorker={currentWorker} />}
          {activePage === 'documents'        && <DocumentsPage showToast={showToast} currentWorker={currentWorker} />}
        </div>
      </div>

      {blastOpen && <SendBlastModal onClose={() => setBlastOpen(false)} showToast={showToast} />}
      {scanOpen  && <ScanModal      onClose={() => setScanOpen(false)}  showToast={showToast} />}
      {notifSettingsOpen && <NotificationSettings currentWorker={currentWorker} showToast={showToast} onClose={() => setNotifSettingsOpen(false)} />}
      {mfaOpen && <MfaSettings showToast={showToast} onChanged={mfa.refresh} onClose={() => { setMfaOpen(false); mfa.refresh(); }} />}

      {/* ── Preview Worker View overlay ──────────────────────────────────── */}
      {previewMode && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: C.bg, display: 'flex', flexDirection: 'column' }}>
          <div style={{ background: '#1a1a2e', borderBottom: `2px solid ${C.accent}`, padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <span style={{ fontSize: 11, color: C.accent, fontFamily: '"DM Mono", monospace', fontWeight: 700, letterSpacing: 1 }}>PREVIEW MODE — Worker Portal</span>
            <span style={{ fontSize: 11, color: C.textMuted }}>Viewing as: {currentWorker?.name} — anything you submit here is saved for real under your own name</span>
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
