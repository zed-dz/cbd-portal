import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { C, btnPrimary, btnSecondary } from '../theme';
import { DashboardPage } from '../pages/Dashboard/DashboardPage';
import { WorkersPage } from '../pages/Workers/WorkersPage';
import { AllocationsPage } from '../pages/Allocations/AllocationsPage';
import { AllocationsCalendarPage } from '../pages/Calendar/AllocationsCalendarPage';
import { TimesheetsPage } from '../pages/Timesheets/TimesheetsPage';
import { ClientsPage } from '../pages/Clients/ClientsPage';
import { ClientApprovalsPage } from '../pages/ClientApprovals/ClientApprovalsPage';
import { PayrollTrackerPage } from '../pages/Payroll/PayrollTrackerPage';
import { PayrollConfigPage } from '../pages/Payroll/PayrollConfigPage';
import { LicenceAgentPage } from '../pages/LicenceAgent/LicenceAgentPage';
import { ReportsPage } from '../pages/Reports/ReportsPage';
import { BulkMessagesPage } from '../pages/BulkMessages/BulkMessagesPage';
import { AppViewsPage } from '../pages/AppViews/AppViewsPage';
import { PendingWorkersPage } from '../pages/PendingWorkers/PendingWorkersPage';

export function AdminPortal({ currentWorker, onSignOut, showToast, isMobile, sidebarOpen, setSidebarOpen }) {
  const [activePage, setActivePage] = useState('dashboard');
  const [badges, setBadges] = useState({ workers: 0, allocations: 0, timesheets: 0, client_approvals: 0, licence_agent: 0, pending_workers: 0 });

  const refreshBadge = useCallback(async () => {
    const [w, a, ts, ca, lic, pw] = await Promise.all([
      supabase.from('workers').select('*', { count: 'exact', head: true }),
      supabase.from('allocations').select('*', { count: 'exact', head: true }).in('status', ['pending', 'confirmed']),
      supabase.from('timesheets').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('timesheets').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('certifications').select('*', { count: 'exact', head: true }).lt('expiry', new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]),
      supabase.from('workers').select('*', { count: 'exact', head: true }).neq('app_status', 'Active'),
    ]);
    setBadges({
      workers: w.count || 0,
      allocations: a.count || 0,
      timesheets: ts.count || 0,
      client_approvals: ca.count || 0,
      licence_agent: lic.count || 0,
      pending_workers: pw.count || 0,
    });
  }, []);

  useEffect(() => { refreshBadge(); }, [refreshBadge]);

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
        { id: 'payroll', label: '💰 Payroll' },
        { id: 'payroll_config', label: '⚙ Payroll Config' },
      ],
    },
    {
      label: 'TOOLS',
      items: [
        { id: 'bulk_messages', label: '📢 Bulk Messages' },
        { id: 'licence_agent', label: '🪪 Licence Agent', badge: badges.licence_agent || null, badgeColor: 'red' },
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
      ...(isMobile ? { position: 'fixed', top: 0, left: 0, zIndex: 500, transform: sidebarOpen ? 'translateX(0)' : `translateX(-${C.sidebarW}px)`, transition: 'transform 0.25s ease' } : {}),
    }}>
      <div style={{ padding: '20px 18px 18px', borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}>
        <div style={{ fontFamily: 'Syne, sans-serif', fontSize: 26, fontWeight: 800, color: C.accent, lineHeight: 1 }}>CBD</div>
        <div style={{ fontSize: 9, color: C.textMuted, fontFamily: '"DM Mono", monospace', letterSpacing: 2, textTransform: 'uppercase', marginTop: 2 }}>Operations Portal</div>
      </div>
      <nav style={{ flex: 1, padding: '0 10px' }}>
        {navSections.map(section => (
          <div key={section.label} style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', color: C.textMuted, padding: '0 8px', marginBottom: 5, fontFamily: '"DM Mono", monospace' }}>{section.label}</div>
            {section.items.map(item => {
              const active = activePage === item.id;
              const bc = item.badgeColor ? BADGE_COLORS[item.badgeColor] : null;
              return (
                <button key={item.id} onClick={() => navigate(item.id)} style={{
                  width: '100%', textAlign: 'left', background: active ? C.cardHover : 'transparent',
                  color: active ? C.text : C.textMuted, border: 'none',
                  borderLeft: `3px solid ${active ? C.accent : 'transparent'}`,
                  borderRadius: '0 8px 8px 0', padding: '8px 10px', cursor: 'pointer',
                  fontSize: 13, fontWeight: 500, marginBottom: 2, transition: 'all 0.15s',
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <span style={{ flex: 1 }}>{item.label}</span>
                  {item.badge && bc ? (
                    <span style={{ background: bc.bg, color: bc.text, borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 5px', fontFamily: '"DM Mono", monospace' }}>
                      {item.badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <div style={{ padding: '11px 15px', background: C.cardHover, borderTop: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 4, fontFamily: '"DM Mono", monospace', textTransform: 'uppercase', letterSpacing: 1 }}>Signed In</div>
        <div>
          <span style={{ display: 'inline-block', width: 7, height: 7, background: C.success, borderRadius: '50%', marginRight: 5 }} />
          <strong style={{ fontSize: 12, color: C.text }}>{currentWorker?.name}</strong>
        </div>
        <div style={{ fontSize: 10, color: C.textMuted, marginTop: 1, fontFamily: '"DM Mono", monospace' }}>ROAD · RAIL · WATER</div>
        <button onClick={onSignOut} style={{ marginTop: 8, background: 'none', border: `1px solid ${C.border}`, color: C.textMuted, borderRadius: 6, padding: '4px 10px', fontSize: 10, cursor: 'pointer', fontFamily: '"DM Mono", monospace', width: '100%' }}>
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
        <div style={{ background: C.sidebar, borderBottom: `1px solid ${C.border}`, padding: '0 24px', height: 48, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {isMobile && (
              <button onClick={() => setSidebarOpen(o => !o)} style={{ background: 'none', border: 'none', color: C.text, cursor: 'pointer', fontSize: 22, lineHeight: 1, padding: 4 }}>☰</button>
            )}
            <span style={{ fontSize: 10, color: C.textMuted, fontFamily: '"DM Mono", monospace' }}>CBD PLANT & LABOUR · ABN: 75 663 693 070</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ ...btnSecondary, padding: '7px 14px', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>📷 Scan</button>
            <button style={{ ...btnPrimary, padding: '7px 14px', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>📢 Send Blast</button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? 12 : 24 }}>
          {activePage === 'dashboard'        && <DashboardPage showToast={showToast} currentWorker={currentWorker} onNavigate={navigate} />}
          {activePage === 'workers'          && <WorkersPage showToast={showToast} />}
          {activePage === 'allocations'      && <AllocationsPage showToast={showToast} />}
          {activePage === 'calendar'         && <AllocationsCalendarPage showToast={showToast} />}
          {activePage === 'pending_workers'  && <PendingWorkersPage showToast={showToast} />}
          {activePage === 'timesheets'       && <TimesheetsPage showToast={showToast} isMobile={isMobile} refreshBadge={refreshBadge} />}
          {activePage === 'clients'          && <ClientsPage showToast={showToast} />}
          {activePage === 'client_approvals' && <ClientApprovalsPage showToast={showToast} />}
          {activePage === 'payroll'          && <PayrollTrackerPage showToast={showToast} />}
          {activePage === 'payroll_config'   && <PayrollConfigPage showToast={showToast} />}
          {activePage === 'licence_agent'    && <LicenceAgentPage showToast={showToast} />}
          {activePage === 'reports'          && <ReportsPage showToast={showToast} />}
          {activePage === 'bulk_messages'    && <BulkMessagesPage showToast={showToast} />}
          {activePage === 'app_views'        && <AppViewsPage showToast={showToast} />}
        </div>
      </div>
    </div>
  );
}
