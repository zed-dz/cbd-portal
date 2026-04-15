import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from './supabaseClient';

// ─── THEME CONSTANTS ────────────────────────────────────────────────────────
const C = {
  bg: '#0f172a',
  card: '#1e293b',
  cardHover: '#273548',
  border: '#334155',
  accent: '#3b82f6',
  accentHover: '#2563eb',
  text: '#f1f5f9',
  textMuted: '#94a3b8',
  success: '#22c55e',
  warning: '#eab308',
  error: '#ef4444',
  info: '#3b82f6',
  sidebar: '#1e293b',
  sidebarW: 240,
};

// ─── TOAST SYSTEM ────────────────────────────────────────────────────────────
function ToastContainer({ toasts, onRemove }) {
  return (
    <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          background: t.type === 'success' ? C.success : t.type === 'error' ? C.error : C.info,
          color: '#fff', padding: '12px 16px', borderRadius: 8, minWidth: 280, maxWidth: 360,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)', display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', fontSize: 14, animation: 'slideIn 0.2s ease',
        }}>
          <span>{t.message}</span>
          <button onClick={() => onRemove(t.id)} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', marginLeft: 12, fontSize: 16, lineHeight: 1 }}>×</button>
        </div>
      ))}
    </div>
  );
}

// ─── SPINNER ─────────────────────────────────────────────────────────────────
function Spinner({ size = 24 }) {
  return (
    <div style={{
      width: size, height: size, border: `3px solid ${C.border}`,
      borderTop: `3px solid ${C.accent}`, borderRadius: '50%',
      animation: 'spin 0.7s linear infinite', display: 'inline-block',
    }} />
  );
}

// ─── STATUS BADGE ─────────────────────────────────────────────────────────────
function Badge({ label, color }) {
  const colors = {
    green: { bg: '#16653a', text: '#4ade80' },
    yellow: { bg: '#713f12', text: '#fde047' },
    red: { bg: '#7f1d1d', text: '#fca5a5' },
    blue: { bg: '#1e3a5f', text: '#93c5fd' },
    gray: { bg: '#1e293b', text: '#94a3b8' },
  };
  const c = colors[color] || colors.gray;
  return (
    <span style={{ background: c.bg, color: c.text, padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600 }}>
      {label}
    </span>
  );
}

// ─── MODAL WRAPPER ────────────────────────────────────────────────────────────
function Modal({ title, onClose, children, width = 480 }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.card, borderRadius: 12, padding: 28, width: '100%', maxWidth: width,
        maxHeight: '90vh', overflowY: 'auto', border: `1px solid ${C.border}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, color: C.text, fontSize: 18 }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textMuted, cursor: 'pointer', fontSize: 22, lineHeight: 1 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── FORM FIELD ───────────────────────────────────────────────────────────────
function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', color: C.textMuted, fontSize: 13, marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle = {
  width: '100%', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6,
  color: C.text, padding: '9px 12px', fontSize: 14, boxSizing: 'border-box', outline: 'none',
};

const btnPrimary = {
  background: C.accent, color: '#fff', border: 'none', borderRadius: 6,
  padding: '10px 20px', cursor: 'pointer', fontSize: 14, fontWeight: 600,
};

const btnSecondary = {
  background: 'transparent', color: C.textMuted, border: `1px solid ${C.border}`,
  borderRadius: 6, padding: '10px 20px', cursor: 'pointer', fontSize: 14,
};

const btnDanger = {
  background: '#7f1d1d', color: '#fca5a5', border: 'none', borderRadius: 6,
  padding: '6px 14px', cursor: 'pointer', fontSize: 13,
};

const btnSmall = {
  background: C.cardHover, color: C.text, border: `1px solid ${C.border}`,
  borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 13,
};

// ─── EMPTY STATE ──────────────────────────────────────────────────────────────
function EmptyState({ message }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', color: C.textMuted }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>📭</div>
      <p style={{ margin: 0 }}>{message}</p>
    </div>
  );
}

// ─── TABLE WRAPPER ────────────────────────────────────────────────────────────
function TableWrap({ children }) {
  return (
    <div style={{ overflowX: 'auto', borderRadius: 8, border: `1px solid ${C.border}` }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', color: C.text, fontSize: 14 }}>
        {children}
      </table>
    </div>
  );
}

function Th({ children }) {
  return <th style={{ padding: '12px 16px', textAlign: 'left', color: C.textMuted, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', background: C.bg, borderBottom: `1px solid ${C.border}` }}>{children}</th>;
}

function Td({ children }) {
  return <td style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>{children}</td>;
}

// ─── ALLOCATION STATUS HELPERS ────────────────────────────────────────────────
function allocationBadge(status) {
  const map = { pending: 'yellow', confirmed: 'blue', completed: 'green', cancelled: 'red' };
  return <Badge label={status} color={map[status] || 'gray'} />;
}

function timesheetBadge(status) {
  const map = { pending: 'yellow', approved: 'green', rejected: 'red' };
  return <Badge label={status} color={map[status] || 'gray'} />;
}

function certBadge(expiry) {
  if (!expiry) return <Badge label="No expiry" color="gray" />;
  const d = new Date(expiry);
  const now = new Date();
  const diff = (d - now) / (1000 * 60 * 60 * 24);
  if (diff < 0) return <Badge label="Expired" color="red" />;
  if (diff < 30) return <Badge label="Expiring soon" color="yellow" />;
  return <Badge label="Valid" color="green" />;
}

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────
function fmtDate(str) {
  if (!str) return '—';
  return new Date(str).toLocaleDateString('en-AU');
}

function fmtDateTime(str) {
  if (!str) return '—';
  return new Date(str).toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'short' });
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

// ─── CSV EXPORT ───────────────────────────────────────────────────────────────
function downloadCSV(filename, rows) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(','), ...rows.map(r => headers.map(h => {
    const val = r[h] == null ? '' : String(r[h]).replace(/"/g, '""');
    return `"${val}"`;
  }).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [session, setSession] = useState(null);
  const [currentWorker, setCurrentWorker] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [toasts, setToasts] = useState([]);
  const toastId = useRef(0);

  // Responsive
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const isMobile = windowWidth < 768;
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const showToast = useCallback((message, type = 'info') => {
    const id = ++toastId.current;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const fetchWorker = useCallback(async (email) => {
    const { data, error } = await supabase.from('workers').select('*').eq('email', email).maybeSingle();
    if (error) { showToast('Could not load profile: ' + error.message, 'error'); }
    setCurrentWorker(data ?? null);
    setAuthLoading(false);
  }, [showToast]);

  // Auth init
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) fetchWorker(session.user.email);
      else setAuthLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) { setAuthLoading(true); fetchWorker(session.user.email); }
      else { setCurrentWorker(null); setAuthLoading(false); }
    });

    return () => subscription.unsubscribe();
  }, [fetchWorker]);

  async function handleLogin(e) {
    e.preventDefault();
    setLoginError('');
    if (!loginEmail || !loginPassword) { setLoginError('Email and password are required.'); return; }
    setLoginLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: loginEmail, password: loginPassword });
    setLoginLoading(false);
    if (error) setLoginError(error.message);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    setSidebarOpen(false);
  }

  // ── GLOBAL CSS ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { background: ${C.bg}; color: ${C.text}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes slideIn { from { transform: translateX(40px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      input:focus, select:focus, textarea:focus { border-color: ${C.accent} !important; }
      button:disabled { opacity: 0.5; cursor: not-allowed !important; }
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-track { background: ${C.bg}; }
      ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
    `;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  if (authLoading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg }}>
        <Spinner size={40} />
      </div>
    );
  }

  return (
    <>
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      {!session ? (
        <LoginPage
          email={loginEmail} setEmail={setLoginEmail}
          password={loginPassword} setPassword={setLoginPassword}
          error={loginError} loading={loginLoading}
          onSubmit={handleLogin}
        />
      ) : !currentWorker ? (
        <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: C.bg, gap: 16, padding: 24 }}>
          <div style={{ color: C.error, fontSize: 18, fontWeight: 700 }}>No worker profile found</div>
          <p style={{ color: C.textMuted, fontSize: 14, textAlign: 'center', maxWidth: 320 }}>
            Your account is not linked to a worker profile. Contact your administrator.
          </p>
          <button onClick={handleSignOut} style={btnSecondary}>Sign Out</button>
        </div>
      ) : currentWorker.role === 'admin' ? (
        <AdminPortal
          currentWorker={currentWorker}
          onSignOut={handleSignOut}
          showToast={showToast}
          isMobile={isMobile}
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
        />
      ) : (
        <WorkerPortal
          currentWorker={currentWorker}
          onSignOut={handleSignOut}
          showToast={showToast}
          isMobile={isMobile}
        />
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════
function LoginPage({ email, setEmail, password, setPassword, error, loading, onSubmit }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg, padding: 16 }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: C.text, letterSpacing: -0.5 }}>CBD Plant & Labour</div>
          <div style={{ color: C.textMuted, marginTop: 4, fontSize: 14 }}>Operations Portal</div>
        </div>
        <div style={{ background: C.card, borderRadius: 12, padding: 32, border: `1px solid ${C.border}` }}>
          <h2 style={{ color: C.text, marginBottom: 24, fontSize: 20 }}>Sign In</h2>
          <form onSubmit={onSubmit}>
            <Field label="Email">
              <input style={inputStyle} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
            </Field>
            <Field label="Password">
              <input style={inputStyle} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
            </Field>
            {error && <p style={{ color: C.error, fontSize: 13, marginBottom: 16 }}>{error}</p>}
            <button type="submit" disabled={loading} style={{ ...btnPrimary, width: '100%', padding: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              {loading ? <><Spinner size={16} /> Signing in…</> : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN PORTAL
// ═══════════════════════════════════════════════════════════════════════════════
function AdminPortal({ currentWorker, onSignOut, showToast, isMobile, sidebarOpen, setSidebarOpen }) {
  const [activePage, setActivePage] = useState('dashboard');
  const [pendingCount, setPendingCount] = useState(0);

  const refreshBadge = useCallback(async () => {
    const { count } = await supabase.from('timesheets').select('*', { count: 'exact', head: true }).eq('status', 'pending');
    setPendingCount(count || 0);
  }, []);

  useEffect(() => { refreshBadge(); }, [refreshBadge]);

  const navSections = [
    {
      label: 'MAIN',
      items: [
        { id: 'dashboard', label: '📊 Dashboard' },
        { id: 'workers', label: '👷 Workers' },
        { id: 'allocations', label: '📋 Allocations' },
        { id: 'pending_workers', label: '⏳ Pending Workers' },
      ],
    },
    {
      label: 'FINANCE',
      items: [
        { id: 'timesheets', label: '🕐 Timesheets', badge: pendingCount || null },
        { id: 'clients', label: '🏗 Clients & Rates' },
        { id: 'client_approvals', label: '✅ Client Approvals' },
        { id: 'payroll', label: '💰 Payroll Tracker' },
      ],
    },
    {
      label: 'TOOLS',
      items: [
        { id: 'certifications', label: '📜 Certifications' },
        { id: 'reports', label: '📁 Reports' },
        { id: 'bulk_messages', label: '📢 Bulk Messages' },
      ],
    },
  ];
  const navItems = navSections.flatMap(s => s.items);

  const navigate = (id) => { setActivePage(id); if (isMobile) setSidebarOpen(false); };

  const sidebar = (
    <div style={{
      width: C.sidebarW, background: C.sidebar, height: '100vh', display: 'flex',
      flexDirection: 'column', borderRight: `1px solid ${C.border}`, flexShrink: 0,
      ...(isMobile ? { position: 'fixed', top: 0, left: 0, zIndex: 500, transform: sidebarOpen ? 'translateX(0)' : `translateX(-${C.sidebarW}px)`, transition: 'transform 0.25s ease' } : {}),
    }}>
      <div style={{ padding: '20px 16px', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>CBD Plant & Labour</div>
        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Admin Portal</div>
      </div>
      <nav style={{ flex: 1, padding: '8px 8px', overflowY: 'auto' }}>
        {navSections.map(section => (
          <div key={section.label}>
            <div style={{ padding: '10px 12px 4px', fontSize: 10, color: C.textMuted, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase' }}>{section.label}</div>
            {section.items.map(item => (
              <button key={item.id} onClick={() => navigate(item.id)} style={{
                width: '100%', textAlign: 'left', background: activePage === item.id ? C.accent : 'none',
                color: activePage === item.id ? '#fff' : C.textMuted, border: 'none', borderRadius: 6,
                padding: '9px 12px', cursor: 'pointer', fontSize: 13, marginBottom: 1, transition: 'all 0.15s',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <span>{item.label}</span>
                {item.badge ? (
                  <span style={{ background: C.error, color: '#fff', borderRadius: 10, fontSize: 11, fontWeight: 700, padding: '1px 7px', minWidth: 20, textAlign: 'center' }}>
                    {item.badge}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ))}
      </nav>
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
        {/* Top bar */}
        <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '0 20px', height: 56, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {isMobile && (
              <button onClick={() => setSidebarOpen(o => !o)} style={{ background: 'none', border: 'none', color: C.text, cursor: 'pointer', fontSize: 22, lineHeight: 1, padding: 4 }}>☰</button>
            )}
            <span style={{ color: C.text, fontWeight: 600, fontSize: 15 }}>{navItems.find(n => n.id === activePage)?.label}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: C.textMuted, fontSize: 13 }}>👤 {currentWorker?.name}</span>
            <button onClick={onSignOut} style={{ ...btnSecondary, padding: '6px 14px', fontSize: 13 }}>Sign Out</button>
          </div>
        </div>
        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? 12 : 24 }}>
          {activePage === 'dashboard' && <DashboardPage showToast={showToast} />}
          {activePage === 'workers' && <WorkersPage showToast={showToast} />}
          {activePage === 'allocations' && <AllocationsPage showToast={showToast} />}
          {activePage === 'pending_workers' && <PendingWorkersPage showToast={showToast} />}
          {activePage === 'timesheets' && <TimesheetsPage showToast={showToast} isMobile={isMobile} refreshBadge={refreshBadge} />}
          {activePage === 'clients' && <ClientsPage showToast={showToast} />}
          {activePage === 'client_approvals' && <ClientApprovalsPage showToast={showToast} />}
          {activePage === 'payroll' && <PayrollTrackerPage showToast={showToast} />}
          {activePage === 'certifications' && <CertificationsPage showToast={showToast} isMobile={isMobile} />}
          {activePage === 'reports' && <ReportsPage showToast={showToast} />}
          {activePage === 'bulk_messages' && <BulkMessagesPage showToast={showToast} />}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD PAGE
// ═══════════════════════════════════════════════════════════════════════════════
function DashboardPage({ showToast }) {
  const [stats, setStats] = useState(null);
  const [recentTimesheets, setRecentTimesheets] = useState([]);
  const [expiredCerts, setExpiredCerts] = useState([]);
  const [dismissedAlerts, setDismissedAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [onSite, available, pendingTs, expiringCerts, recent, expired] = await Promise.all([
          supabase.from('workers').select('id', { count: 'exact' }).eq('status', 'on_site'),
          supabase.from('workers').select('id', { count: 'exact' }).eq('status', 'available'),
          supabase.from('timesheets').select('id', { count: 'exact' }).eq('status', 'pending'),
          supabase.from('certifications').select('id', { count: 'exact' })
            .lte('expiry', new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0])
            .gte('expiry', todayISO()),
          supabase.from('timesheets').select('*, workers(name)').order('created_at', { ascending: false }).limit(5),
          supabase.from('certifications').select('*, workers(name)').lt('expiry', todayISO()),
        ]);

        if (!mounted) return;
        setStats({
          onSite: onSite.count || 0,
          available: available.count || 0,
          pendingTs: pendingTs.count || 0,
          expiringCerts: expiringCerts.count || 0,
        });
        setRecentTimesheets(recent.data || []);
        setExpiredCerts(expired.data || []);
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [showToast]);

  const statCards = [
    { label: 'Workers On Site', value: stats?.onSite, color: C.success },
    { label: 'Available Pool', value: stats?.available, color: C.accent },
    { label: 'Pending Timesheets', value: stats?.pendingTs, color: C.warning },
    { label: 'Expiring Certs (30d)', value: stats?.expiringCerts, color: C.error },
  ];

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}><Spinner size={36} /></div>;

  const visibleAlerts = expiredCerts.filter(c => !dismissedAlerts.includes(c.id));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
        {statCards.map(sc => (
          <div key={sc.label} style={{ background: C.card, borderRadius: 10, padding: '20px 24px', border: `1px solid ${C.border}`, borderLeft: `3px solid ${sc.color}` }}>
            <div style={{ fontSize: 36, fontWeight: 800, color: sc.color }}>{sc.value ?? '—'}</div>
            <div style={{ color: C.textMuted, fontSize: 13, marginTop: 4 }}>{sc.label}</div>
          </div>
        ))}
      </div>

      {visibleAlerts.length > 0 && (
        <div style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 10, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span>🚨</span>
            <span style={{ fontWeight: 700, color: C.error, fontSize: 14 }}>Expired Certifications</span>
            <Badge label={`${visibleAlerts.length} REQUIRES ACTION`} color="red" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {visibleAlerts.map(c => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: C.card, borderRadius: 8, padding: '10px 14px' }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{c.workers?.name || '—'}</span>
                  <span style={{ fontSize: 12, color: C.textMuted, marginLeft: 8 }}>{c.cert_name} — expired {fmtDate(c.expiry)}</span>
                </div>
                <button onClick={() => setDismissedAlerts(d => [...d, c.id])} style={{ ...btnSecondary, padding: '4px 10px', fontSize: 12 }}>Dismiss</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 24 }}>
        <h3 style={{ color: C.text, marginBottom: 16, fontSize: 16 }}>Recent Timesheets</h3>
        {recentTimesheets.length === 0 ? (
          <EmptyState message="No timesheets yet." />
        ) : (
          <TableWrap>
            <thead><tr><Th>Worker</Th><Th>Date</Th><Th>Hours</Th><Th>Status</Th></tr></thead>
            <tbody>
              {recentTimesheets.map(ts => (
                <tr key={ts.id}>
                  <Td>{ts.workers?.name || '—'}</Td>
                  <Td>{fmtDate(ts.date)}</Td>
                  <Td>{ts.hours ?? '—'}</Td>
                  <Td>{timesheetBadge(ts.status)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKERS PAGE
// ═══════════════════════════════════════════════════════════════════════════════
const JOB_TITLES = [
  'Excavator Operator','Dozer Operator','Multiskilled Operator','Skilled Labourer',
  'Confined Space Labour','Moxie/Dump Truck Operator','Dogman','Leading Hand',
  'Foreman','Site Engineer','Concreter','Scaffolder','General Labourer',
  'Formwork Carpenter','Steel Fixer','EWP Operator','Skid Steer Operator',
  'Roller Operator','Grader Operator','Hirail Operator','Crane Operator',
  'RIW Worker','Civil Leading Hand','Rigger',
];

const workerDefaults = { name: '', email: '', mobile: '', role: 'worker', job_title: '', licences: '', address: '', access_level: 'employee', status: 'available', app_status: 'Active', site: '', client: '' };

function WorkersPage({ showToast }) {
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null); // null | 'add' | worker obj
  const [form, setForm] = useState(workerDefaults);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('workers').select('*').order('created_at', { ascending: false });
    if (error) showToast(error.message, 'error');
    else setWorkers(data || []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm(workerDefaults); setModal('add'); };
  const openEdit = (w) => { setForm({ name: w.name, email: w.email, mobile: w.mobile || '', role: w.role, job_title: w.job_title || '', licences: w.licences || '', address: w.address || '', access_level: w.access_level || 'employee', status: w.status, app_status: w.app_status || 'Active', site: w.site || '', client: w.client || '' }); setModal(w); };
  const closeModal = () => { setModal(null); setForm(workerDefaults); };

  const handleSave = async () => {
    if (!form.name.trim() || !form.email.trim()) { showToast('Name and email are required.', 'error'); return; }
    setSaving(true);
    if (modal === 'add') {
      const { error } = await supabase.from('workers').insert([form]);
      if (error) showToast(error.message, 'error');
      else { showToast('Worker created successfully', 'success'); closeModal(); load(); }
    } else {
      const { error } = await supabase.from('workers').update(form).eq('id', modal.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Worker updated successfully', 'success'); closeModal(); load(); }
    }
    setSaving(false);
  };

  const handleDelete = async (w) => {
    if (!window.confirm(`Delete ${w.name}? This cannot be undone.`)) return;
    const { error } = await supabase.from('workers').delete().eq('id', w.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Worker deleted', 'success'); load(); }
  };

  const filtered = workers.filter(w => w.name.toLowerCase().includes(search.toLowerCase()) || w.email.toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <input style={{ ...inputStyle, maxWidth: 280 }} placeholder="Search by name or email…" value={search} onChange={e => setSearch(e.target.value)} />
        <button onClick={openAdd} style={btnPrimary}>+ Add Worker</button>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : filtered.length === 0 ? (
        <EmptyState message="No workers found. Add one to get started." />
      ) : (
        <TableWrap>
          <thead><tr><Th>Name</Th><Th>Job Title</Th><Th>Mobile</Th><Th>Licences</Th><Th>Status</Th><Th>App Status</Th><Th>Site</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {filtered.map(w => (
              <tr key={w.id}>
                <Td>
                  <div><strong>{w.name}</strong></div>
                  <div style={{ fontSize: 12, color: C.textMuted }}>{w.email}</div>
                </Td>
                <Td>{w.job_title || <span style={{ color: C.textMuted }}>—</span>}</Td>
                <Td>{w.mobile || '—'}</Td>
                <Td><span style={{ fontSize: 12, color: C.textMuted }}>{w.licences || '—'}</span></Td>
                <Td><Badge label={w.status || 'available'} color={w.status === 'on_site' ? 'green' : w.status === 'job_details_sent' ? 'yellow' : 'blue'} /></Td>
                <Td><Badge label={w.app_status || 'Active'} color={w.app_status === 'Active' ? 'green' : w.app_status === 'Profile Incomplete' ? 'yellow' : 'gray'} /></Td>
                <Td>{w.site || '—'}</Td>
                <Td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => openEdit(w)} style={btnSmall}>Edit</button>
                    <button onClick={() => handleDelete(w)} style={btnDanger}>Delete</button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      {modal && (
        <Modal title={modal === 'add' ? 'Add Worker' : 'Edit Worker'} onClose={closeModal} width={560}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <Field label="Full Name *"><input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></Field>
            <Field label="Email *"><input style={inputStyle} type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></Field>
            <Field label="Mobile"><input style={inputStyle} value={form.mobile} onChange={e => setForm(f => ({ ...f, mobile: e.target.value }))} /></Field>
            <Field label="Job Title">
              <>
                <input style={inputStyle} list="job-titles-list" value={form.job_title} onChange={e => setForm(f => ({ ...f, job_title: e.target.value }))} placeholder="Type or select a role…" />
                <datalist id="job-titles-list">
                  {JOB_TITLES.map(t => <option key={t} value={t} />)}
                </datalist>
              </>
            </Field>
            <Field label="Licences / Tickets"><input style={inputStyle} value={form.licences} onChange={e => setForm(f => ({ ...f, licences: e.target.value }))} placeholder="e.g. EWP, VOC Excavator, RIW…" /></Field>
            <Field label="Address"><input style={inputStyle} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></Field>
            <Field label="Portal Access">
              <select style={inputStyle} value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                <option value="worker">Worker</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
            <Field label="Access Level">
              <select style={inputStyle} value={form.access_level} onChange={e => setForm(f => ({ ...f, access_level: e.target.value }))}>
                <option value="employee">Employee</option>
                <option value="manager">Manager</option>
              </select>
            </Field>
            <Field label="Work Status">
              <select style={inputStyle} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                <option value="available">Available</option>
                <option value="on_site">On Site</option>
                <option value="job_details_sent">Job Details Sent</option>
                <option value="unavailable">Unavailable</option>
              </select>
            </Field>
            <Field label="App Status">
              <select style={inputStyle} value={form.app_status} onChange={e => setForm(f => ({ ...f, app_status: e.target.value }))}>
                <option value="Active">Active</option>
                <option value="Invite Sent">Invite Sent</option>
                <option value="Completing Profile">Completing Profile</option>
                <option value="Profile Incomplete">Profile Incomplete</option>
                <option value="Inactive">Inactive</option>
              </select>
            </Field>
            <Field label="Current Site"><input style={inputStyle} value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} /></Field>
            <Field label="Current Client"><input style={inputStyle} value={form.client} onChange={e => setForm(f => ({ ...f, client: e.target.value }))} /></Field>
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={closeModal} style={btnSecondary}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALLOCATIONS PAGE
// ═══════════════════════════════════════════════════════════════════════════════
const allocDefaults = { worker_id: '', site: '', client: '', project: '', address: '', site_manager: '', manager_phone: '', status: 'pending', start_date: '', start_time: '', end_time: '', notes: '' };

function AllocationsPage({ showToast }) {
  const [allocations, setAllocations] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(allocDefaults);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [a, w] = await Promise.all([
      supabase.from('allocations').select('*, workers(name)').order('created_at', { ascending: false }),
      supabase.from('workers').select('id, name').order('name'),
    ]);
    if (a.error) showToast(a.error.message, 'error');
    else setAllocations(a.data || []);
    if (w.data) setWorkers(w.data);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm(allocDefaults); setModal('add'); };
  const openEdit = (a) => {
    setForm({ worker_id: a.worker_id || '', site: a.site || '', client: a.client || '', project: a.project || '', address: a.address || '', site_manager: a.site_manager || '', manager_phone: a.manager_phone || '', status: a.status, start_date: a.start_date || '', start_time: a.start_time ? a.start_time.slice(0, 16) : '', end_time: a.end_time ? a.end_time.slice(0, 16) : '', notes: a.notes || '' });
    setModal(a);
  };
  const closeModal = () => { setModal(null); setForm(allocDefaults); };

  const handleSave = async () => {
    if (!form.worker_id) { showToast('Please select a worker.', 'error'); return; }
    setSaving(true);
    const payload = { ...form, start_time: form.start_time || null, end_time: form.end_time || null };
    if (modal === 'add') {
      const { error } = await supabase.from('allocations').insert([payload]);
      if (error) showToast(error.message, 'error');
      else { showToast('Allocation created successfully', 'success'); closeModal(); load(); }
    } else {
      const { error } = await supabase.from('allocations').update(payload).eq('id', modal.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Allocation updated successfully', 'success'); closeModal(); load(); }
    }
    setSaving(false);
  };

  const handleDelete = async (a) => {
    if (!window.confirm('Delete this allocation?')) return;
    const { error } = await supabase.from('allocations').delete().eq('id', a.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Allocation deleted', 'success'); load(); }
  };

  const filtered = allocations.filter(a => !filterStatus || a.status === filterStatus);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <select style={{ ...inputStyle, maxWidth: 200 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="confirmed">Confirmed</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <button onClick={openAdd} style={btnPrimary}>+ Create Allocation</button>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : filtered.length === 0 ? (
        <EmptyState message="No allocations found." />
      ) : (
        <TableWrap>
          <thead><tr><Th>Worker</Th><Th>Client</Th><Th>Project / Site</Th><Th>Site Manager</Th><Th>Start Date</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {filtered.map(a => (
              <tr key={a.id}>
                <Td>{a.workers?.name || '—'}</Td>
                <Td>{a.client || '—'}</Td>
                <Td>
                  <div>{a.project || a.site || '—'}</div>
                  {a.project && a.site && <div style={{ fontSize: 12, color: C.textMuted }}>{a.site}</div>}
                </Td>
                <Td>
                  <div>{a.site_manager || '—'}</div>
                  {a.manager_phone && <div style={{ fontSize: 12, color: C.textMuted }}>{a.manager_phone}</div>}
                </Td>
                <Td>{a.start_date ? fmtDate(a.start_date) : fmtDateTime(a.start_time)}</Td>
                <Td>{allocationBadge(a.status)}</Td>
                <Td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => openEdit(a)} style={btnSmall}>Edit</button>
                    <button onClick={() => handleDelete(a)} style={btnDanger}>Delete</button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      {modal && (
        <Modal title={modal === 'add' ? 'Create Allocation' : 'Edit Allocation'} onClose={closeModal} width={560}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Worker *">
                <select style={inputStyle} value={form.worker_id} onChange={e => setForm(f => ({ ...f, worker_id: e.target.value }))}>
                  <option value="">Select a worker…</option>
                  {workers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Client"><input style={inputStyle} value={form.client} onChange={e => setForm(f => ({ ...f, client: e.target.value }))} /></Field>
            <Field label="Project"><input style={inputStyle} value={form.project} onChange={e => setForm(f => ({ ...f, project: e.target.value }))} /></Field>
            <Field label="Site"><input style={inputStyle} value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} /></Field>
            <Field label="Site Address"><input style={inputStyle} value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></Field>
            <Field label="Site Manager"><input style={inputStyle} value={form.site_manager} onChange={e => setForm(f => ({ ...f, site_manager: e.target.value }))} /></Field>
            <Field label="Manager Phone"><input style={inputStyle} value={form.manager_phone} onChange={e => setForm(f => ({ ...f, manager_phone: e.target.value }))} /></Field>
            <Field label="Start Date"><input style={inputStyle} type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} /></Field>
            <Field label="Status">
              <select style={inputStyle} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                <option value="pending">Pending</option>
                <option value="confirmed">Confirmed</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </Field>
            <Field label="Arrival Time"><input style={inputStyle} type="datetime-local" value={form.start_time} onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))} /></Field>
            <Field label="End Time"><input style={inputStyle} type="datetime-local" value={form.end_time} onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))} /></Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Notes"><textarea style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></Field>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={closeModal} style={btnSecondary}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIMESHEETS PAGE
// ═══════════════════════════════════════════════════════════════════════════════
const tsDefaults = { worker_id: '', client: '', site: '', date: '', hours: '', status: 'pending', notes: '' };

function TimesheetsPage({ showToast, refreshBadge }) {
  const [timesheets, setTimesheets] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(tsDefaults);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [t, w] = await Promise.all([
      supabase.from('timesheets').select('*, workers(name)').order('created_at', { ascending: false }),
      supabase.from('workers').select('id, name').order('name'),
    ]);
    if (t.error) showToast(t.error.message, 'error');
    else setTimesheets(t.data || []);
    if (w.data) setWorkers(w.data);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm(tsDefaults); setModal('add'); };
  const openEdit = (ts) => {
    setForm({ worker_id: ts.worker_id || '', client: ts.client || '', site: ts.site || '', date: ts.date || '', hours: ts.hours ?? '', status: ts.status, notes: ts.notes || '' });
    setModal(ts);
  };
  const closeModal = () => { setModal(null); setForm(tsDefaults); };

  const handleSave = async () => {
    if (!form.worker_id || !form.date || form.hours === '') { showToast('Worker, date and hours are required.', 'error'); return; }
    setSaving(true);
    const payload = { ...form, hours: parseFloat(form.hours) };
    if (modal === 'add') {
      const { error } = await supabase.from('timesheets').insert([payload]);
      if (error) showToast(error.message, 'error');
      else { showToast('Timesheet created successfully', 'success'); closeModal(); load(); refreshBadge?.(); }
    } else {
      const { error } = await supabase.from('timesheets').update(payload).eq('id', modal.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Timesheet updated successfully', 'success'); closeModal(); load(); refreshBadge?.(); }
    }
    setSaving(false);
  };

  const handleDelete = async (ts) => {
    if (!window.confirm('Delete this timesheet?')) return;
    const { error } = await supabase.from('timesheets').delete().eq('id', ts.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Timesheet deleted', 'success'); load(); refreshBadge?.(); }
  };

  const handleApprove = async (ts) => {
    const { error } = await supabase.from('timesheets').update({ status: 'approved' }).eq('id', ts.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Timesheet approved', 'success'); load(); refreshBadge?.(); }
  };

  const handleReject = async (ts) => {
    const { error } = await supabase.from('timesheets').update({ status: 'rejected' }).eq('id', ts.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Timesheet rejected', 'info'); load(); refreshBadge?.(); }
  };

  const handleApproveAll = async () => {
    const pending = timesheets.filter(ts => ts.status === 'pending');
    if (!pending.length) { showToast('No pending timesheets to approve.', 'info'); return; }
    if (!window.confirm(`Approve all ${pending.length} pending timesheets?`)) return;
    const { error } = await supabase.from('timesheets').update({ status: 'approved' }).in('id', pending.map(ts => ts.id));
    if (error) showToast(error.message, 'error');
    else { showToast(`${pending.length} timesheets approved`, 'success'); load(); refreshBadge?.(); }
  };

  const filtered = timesheets.filter(ts => {
    const matchStatus = !filterStatus || ts.status === filterStatus;
    const matchSearch = !search || ts.workers?.name?.toLowerCase().includes(search.toLowerCase()) || (ts.client || '').toLowerCase().includes(search.toLowerCase()) || (ts.site || '').toLowerCase().includes(search.toLowerCase());
    return matchStatus && matchSearch;
  });
  const totalHours = filtered.reduce((sum, ts) => sum + (parseFloat(ts.hours) || 0), 0);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', flex: 1 }}>
          <input style={{ ...inputStyle, maxWidth: 220 }} placeholder="Search worker, client, site…" value={search} onChange={e => setSearch(e.target.value)} />
          <select style={{ ...inputStyle, maxWidth: 180 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleApproveAll} style={{ ...btnSmall, color: '#4ade80', borderColor: '#16653a' }}>✓ Approve All Pending</button>
          <button onClick={openAdd} style={btnPrimary}>+ Add Timesheet</button>
        </div>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : filtered.length === 0 ? (
        <EmptyState message="No timesheets found." />
      ) : (
        <TableWrap>
          <thead><tr><Th>Worker</Th><Th>Date</Th><Th>Client</Th><Th>Site</Th><Th>Hours</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {filtered.map(ts => (
              <tr key={ts.id}>
                <Td>{ts.workers?.name || '—'}</Td>
                <Td>{fmtDate(ts.date)}</Td>
                <Td>{ts.client || '—'}</Td>
                <Td>{ts.site || '—'}</Td>
                <Td>{ts.hours ?? '—'}</Td>
                <Td>{timesheetBadge(ts.status)}</Td>
                <Td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {ts.status === 'pending' && <>
                      <button onClick={() => handleApprove(ts)} style={{ ...btnSmall, color: '#4ade80' }}>✓ Approve</button>
                      <button onClick={() => handleReject(ts)} style={{ ...btnSmall, color: '#fca5a5' }}>✗ Reject</button>
                    </>}
                    <button onClick={() => openEdit(ts)} style={btnSmall}>Edit</button>
                    <button onClick={() => handleDelete(ts)} style={btnDanger}>Delete</button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} style={{ padding: '10px 16px', color: C.textMuted, fontSize: 13, borderTop: `2px solid ${C.border}` }}>
                {filtered.length} record{filtered.length !== 1 ? 's' : ''}
              </td>
              <td style={{ padding: '10px 16px', fontWeight: 700, color: C.text, fontSize: 14, borderTop: `2px solid ${C.border}` }}>
                {totalHours.toFixed(2)} hrs
              </td>
              <td colSpan={2} style={{ borderTop: `2px solid ${C.border}` }} />
            </tr>
          </tfoot>
        </TableWrap>
      )}

      {modal && (
        <Modal title={modal === 'add' ? 'Add Timesheet' : 'Edit Timesheet'} onClose={closeModal}>
          <Field label="Worker *">
            <select style={inputStyle} value={form.worker_id} onChange={e => setForm(f => ({ ...f, worker_id: e.target.value }))}>
              <option value="">Select a worker…</option>
              {workers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <Field label="Date *"><input style={inputStyle} type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} /></Field>
          <Field label="Client"><input style={inputStyle} value={form.client} onChange={e => setForm(f => ({ ...f, client: e.target.value }))} /></Field>
          <Field label="Site"><input style={inputStyle} value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} /></Field>
          <Field label="Hours *"><input style={inputStyle} type="number" step="0.5" min="0" value={form.hours} onChange={e => setForm(f => ({ ...f, hours: e.target.value }))} /></Field>
          <Field label="Status">
            <select style={inputStyle} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </Field>
          <Field label="Notes"><textarea style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></Field>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={closeModal} style={btnSecondary}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CERTIFICATIONS PAGE
// ═══════════════════════════════════════════════════════════════════════════════
const certDefaults = { worker_id: '', cert_name: '', issuer: '', expiry: '' };

function CertificationsPage({ showToast }) {
  const [certs, setCerts] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(certDefaults);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [c, w] = await Promise.all([
      supabase.from('certifications').select('*, workers(name)').order('expiry', { ascending: true }),
      supabase.from('workers').select('id, name').order('name'),
    ]);
    if (c.error) showToast(c.error.message, 'error');
    else setCerts(c.data || []);
    if (w.data) setWorkers(w.data);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm(certDefaults); setModal('add'); };
  const openEdit = (c) => {
    setForm({ worker_id: c.worker_id || '', cert_name: c.cert_name, issuer: c.issuer || '', expiry: c.expiry || '' });
    setModal(c);
  };
  const closeModal = () => { setModal(null); setForm(certDefaults); };

  const handleSave = async () => {
    if (!form.worker_id || !form.cert_name.trim()) { showToast('Worker and certification name are required.', 'error'); return; }
    setSaving(true);
    const payload = { ...form, expiry: form.expiry || null };
    if (modal === 'add') {
      const { error } = await supabase.from('certifications').insert([payload]);
      if (error) showToast(error.message, 'error');
      else { showToast('Certification added successfully', 'success'); closeModal(); load(); }
    } else {
      const { error } = await supabase.from('certifications').update(payload).eq('id', modal.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Certification updated successfully', 'success'); closeModal(); load(); }
    }
    setSaving(false);
  };

  const handleDelete = async (c) => {
    if (!window.confirm('Delete this certification?')) return;
    const { error } = await supabase.from('certifications').delete().eq('id', c.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Certification deleted', 'success'); load(); }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', flex: 1 }}>
          <input style={{ ...inputStyle, maxWidth: 220 }} placeholder="Search worker or cert name…" value={search} onChange={e => setSearch(e.target.value)} />
          <select style={{ ...inputStyle, maxWidth: 180 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="valid">Valid</option>
            <option value="expiring">Expiring Soon</option>
            <option value="expired">Expired</option>
          </select>
        </div>
        <button onClick={openAdd} style={btnPrimary}>+ Add Certification</button>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : (() => {
        const now = new Date();
        const filtered = certs.filter(c => {
          const matchSearch = !search || c.cert_name.toLowerCase().includes(search.toLowerCase()) || (c.workers?.name || '').toLowerCase().includes(search.toLowerCase());
          if (!matchSearch) return false;
          if (!filterStatus) return true;
          if (!c.expiry) return filterStatus === 'valid';
          const diff = (new Date(c.expiry) - now) / (1000 * 60 * 60 * 24);
          if (filterStatus === 'expired') return diff < 0;
          if (filterStatus === 'expiring') return diff >= 0 && diff < 30;
          if (filterStatus === 'valid') return diff >= 30;
          return true;
        });
        return filtered.length === 0 ? <EmptyState message="No certifications found." /> : (
        <TableWrap>
          <thead><tr><Th>Worker</Th><Th>Certification</Th><Th>Issuer</Th><Th>Expiry</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {filtered.map(c => (
              <tr key={c.id}>
                <Td>{c.workers?.name || '—'}</Td>
                <Td><strong>{c.cert_name}</strong></Td>
                <Td>{c.issuer || '—'}</Td>
                <Td>{fmtDate(c.expiry)}</Td>
                <Td>{certBadge(c.expiry)}</Td>
                <Td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => openEdit(c)} style={btnSmall}>Edit</button>
                    <button onClick={() => handleDelete(c)} style={btnDanger}>Delete</button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        );
      })()}

      {modal && (
        <Modal title={modal === 'add' ? 'Add Certification' : 'Edit Certification'} onClose={closeModal}>
          <Field label="Worker *">
            <select style={inputStyle} value={form.worker_id} onChange={e => setForm(f => ({ ...f, worker_id: e.target.value }))}>
              <option value="">Select a worker…</option>
              {workers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <Field label="Certification Name *"><input style={inputStyle} value={form.cert_name} onChange={e => setForm(f => ({ ...f, cert_name: e.target.value }))} /></Field>
          <Field label="Issuer"><input style={inputStyle} value={form.issuer} onChange={e => setForm(f => ({ ...f, issuer: e.target.value }))} /></Field>
          <Field label="Expiry Date"><input style={inputStyle} type="date" value={form.expiry} onChange={e => setForm(f => ({ ...f, expiry: e.target.value }))} /></Field>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={closeModal} style={btnSecondary}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORTS PAGE
// ═══════════════════════════════════════════════════════════════════════════════
function ReportsPage({ showToast }) {
  const [counts, setCounts] = useState({});
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [exporting, setExporting] = useState({});

  useEffect(() => {
    (async () => {
      const [w, a, t, c, cl] = await Promise.all([
        supabase.from('workers').select('id', { count: 'exact' }),
        supabase.from('allocations').select('id', { count: 'exact' }),
        supabase.from('timesheets').select('id', { count: 'exact' }),
        supabase.from('certifications').select('id', { count: 'exact' }),
        supabase.from('clients').select('id', { count: 'exact' }),
      ]);
      setCounts({ workers: w.count || 0, allocations: a.count || 0, timesheets: t.count || 0, certifications: c.count || 0, clients: cl.count || 0 });
    })();
  }, []);

  const doExport = async (type) => {
    setExporting(e => ({ ...e, [type]: true }));
    try {
      if (type === 'workers') {
        const { data, error } = await supabase.from('workers').select('*');
        if (error) throw error;
        downloadCSV(`workers_export_${todayISO()}.csv`, data);
      } else if (type === 'allocations') {
        const { data, error } = await supabase.from('allocations').select('*, workers(name)');
        if (error) throw error;
        const rows = data.map(({ workers, ...r }) => ({ worker_name: workers?.name, ...r }));
        downloadCSV(`allocations_export_${todayISO()}.csv`, rows);
      } else if (type === 'timesheets') {
        let q = supabase.from('timesheets').select('*, workers(name)');
        if (dateFrom) q = q.gte('date', dateFrom);
        if (dateTo) q = q.lte('date', dateTo);
        const { data, error } = await q;
        if (error) throw error;
        const rows = data.map(({ workers, ...r }) => ({ worker_name: workers?.name, ...r }));
        downloadCSV(`timesheets_export_${todayISO()}.csv`, rows);
      } else if (type === 'certifications') {
        const { data, error } = await supabase.from('certifications').select('*, workers(name)');
        if (error) throw error;
        const rows = data.map(({ workers, ...r }) => ({ worker_name: workers?.name, ...r }));
        downloadCSV(`certifications_export_${todayISO()}.csv`, rows);
      } else if (type === 'clients') {
        const { data, error } = await supabase.from('clients').select('*');
        if (error) throw error;
        downloadCSV(`clients_export_${todayISO()}.csv`, data);
      }
      showToast(`${type} exported successfully`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
    setExporting(e => ({ ...e, [type]: false }));
  };

  const exports = [
    { key: 'workers', label: 'Workers Export', desc: 'All worker records' },
    { key: 'allocations', label: 'Allocations Export', desc: 'All allocations with worker names' },
    { key: 'timesheets', label: 'Timesheets Export', desc: 'All timesheets with worker names (use date filter)' },
    { key: 'certifications', label: 'Certifications Export', desc: 'All certifications with worker names' },
    { key: 'clients', label: 'Clients Export', desc: 'All client records with rates and contacts' },
  ];

  return (
    <div>
      <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 20, marginBottom: 20 }}>
        <h3 style={{ color: C.text, marginBottom: 12, fontSize: 15 }}>Date Range Filter (for Timesheets & Allocations)</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <label style={{ color: C.textMuted, fontSize: 13, display: 'block', marginBottom: 4 }}>From</label>
            <input style={{ ...inputStyle, width: 160 }} type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div>
            <label style={{ color: C.textMuted, fontSize: 13, display: 'block', marginBottom: 4 }}>To</label>
            <input style={{ ...inputStyle, width: 160 }} type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </div>
          <button onClick={() => { setDateFrom(''); setDateTo(''); }} style={{ ...btnSecondary, alignSelf: 'flex-end' }}>Clear</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        {exports.map(exp => (
          <div key={exp.key} style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 24 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 4 }}>{exp.label}</div>
            <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 16 }}>{exp.desc}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: C.textMuted, fontSize: 13 }}>{counts[exp.key] ?? '…'} records</span>
              <button onClick={() => doExport(exp.key)} disabled={exporting[exp.key]} style={btnPrimary}>
                {exporting[exp.key] ? 'Exporting…' : '↓ Export CSV'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENTS PAGE
// ═══════════════════════════════════════════════════════════════════════════════
const clientDefaults = { name: '', site: '', contact: '', contact_email: '', contact_phone: '', rate_regular: '', rate_overtime: '', notes: '' };

function ClientsPage({ showToast }) {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(clientDefaults);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('clients').select('*').order('name');
    if (error) showToast(error.message, 'error');
    else setClients(data || []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setForm(clientDefaults); setModal('add'); };
  const openEdit = (c) => {
    setForm({ name: c.name, site: c.site || '', contact: c.contact || '', contact_email: c.contact_email || '', contact_phone: c.contact_phone || '', rate_regular: c.rate_regular ?? '', rate_overtime: c.rate_overtime ?? '', notes: c.notes || '' });
    setModal(c);
  };
  const closeModal = () => { setModal(null); setForm(clientDefaults); };

  const handleSave = async () => {
    if (!form.name.trim()) { showToast('Client name is required.', 'error'); return; }
    setSaving(true);
    const payload = { ...form, rate_regular: form.rate_regular === '' ? null : parseFloat(form.rate_regular), rate_overtime: form.rate_overtime === '' ? null : parseFloat(form.rate_overtime) };
    if (modal === 'add') {
      const { error } = await supabase.from('clients').insert([payload]);
      if (error) showToast(error.message, 'error');
      else { showToast('Client added successfully', 'success'); closeModal(); load(); }
    } else {
      const { error } = await supabase.from('clients').update(payload).eq('id', modal.id);
      if (error) showToast(error.message, 'error');
      else { showToast('Client updated successfully', 'success'); closeModal(); load(); }
    }
    setSaving(false);
  };

  const handleDelete = async (c) => {
    if (!window.confirm(`Delete client "${c.name}"? This cannot be undone.`)) return;
    const { error } = await supabase.from('clients').delete().eq('id', c.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Client deleted', 'success'); load(); }
  };

  const handleExport = async () => {
    const { data, error } = await supabase.from('clients').select('*');
    if (error) { showToast(error.message, 'error'); return; }
    downloadCSV(`clients_export_${todayISO()}.csv`, data);
    showToast('Clients exported', 'success');
  };

  const filtered = clients.filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase()) || (c.site || '').toLowerCase().includes(search.toLowerCase()) || (c.contact || '').toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <input style={{ ...inputStyle, maxWidth: 280 }} placeholder="Search by name, site, contact…" value={search} onChange={e => setSearch(e.target.value)} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleExport} style={btnSecondary}>↓ Export CSV</button>
          <button onClick={openAdd} style={btnPrimary}>+ Add Client</button>
        </div>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : filtered.length === 0 ? (
        <EmptyState message="No clients yet. Add your first client to get started." />
      ) : (
        <TableWrap>
          <thead><tr><Th>Client Name</Th><Th>Site</Th><Th>Contact</Th><Th>Phone</Th><Th>Rate / hr</Th><Th>OT Rate / hr</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {filtered.map(c => (
              <tr key={c.id}>
                <Td><strong>{c.name}</strong></Td>
                <Td>{c.site || '—'}</Td>
                <Td>
                  <div>{c.contact || '—'}</div>
                  {c.contact_email && <div style={{ fontSize: 12, color: C.textMuted }}>{c.contact_email}</div>}
                </Td>
                <Td>{c.contact_phone || '—'}</Td>
                <Td>
                  {c.rate_regular != null
                    ? <span style={{ fontWeight: 700, color: '#f97316' }}>${parseFloat(c.rate_regular).toFixed(2)}</span>
                    : '—'}
                </Td>
                <Td>
                  {c.rate_overtime != null
                    ? <span style={{ fontWeight: 700, color: C.warning }}>${parseFloat(c.rate_overtime).toFixed(2)}</span>
                    : '—'}
                </Td>
                <Td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => openEdit(c)} style={btnSmall}>Edit</button>
                    <button onClick={() => handleDelete(c)} style={btnDanger}>Delete</button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      {modal && (
        <Modal title={modal === 'add' ? 'Add Client' : 'Edit Client'} onClose={closeModal} width={540}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Client Name *"><input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></Field>
            </div>
            <Field label="Site / Project"><input style={inputStyle} value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} /></Field>
            <Field label="Contact Person"><input style={inputStyle} value={form.contact} onChange={e => setForm(f => ({ ...f, contact: e.target.value }))} /></Field>
            <Field label="Contact Email"><input style={inputStyle} type="email" value={form.contact_email} onChange={e => setForm(f => ({ ...f, contact_email: e.target.value }))} /></Field>
            <Field label="Contact Phone"><input style={inputStyle} value={form.contact_phone} onChange={e => setForm(f => ({ ...f, contact_phone: e.target.value }))} /></Field>
            <Field label="Regular Rate ($/hr)"><input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_regular} onChange={e => setForm(f => ({ ...f, rate_regular: e.target.value }))} placeholder="e.g. 68.00" /></Field>
            <Field label="OT Rate ($/hr)"><input style={inputStyle} type="number" step="0.01" min="0" value={form.rate_overtime} onChange={e => setForm(f => ({ ...f, rate_overtime: e.target.value }))} placeholder="e.g. 102.00" /></Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="Notes"><textarea style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></Field>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={closeModal} style={btnSecondary}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PENDING WORKERS PAGE
// ═══════════════════════════════════════════════════════════════════════════════
function PendingWorkersPage({ showToast }) {
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('workers').select('*').neq('app_status', 'Active').order('created_at', { ascending: false });
    if (error) showToast(error.message, 'error');
    else setWorkers(data || []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const handleRemind = (w) => showToast(`Reminder sent to ${w.name.split(' ')[0]}`, 'success');

  const appStatusColor = (s) => s === 'Invite Sent' ? 'blue' : s === 'Completing Profile' ? 'yellow' : s === 'Profile Incomplete' ? 'yellow' : 'gray';

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;
  if (!workers.length) return <EmptyState message="All workers are active — no pending onboarding." />;

  return (
    <div>
      <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 20 }}>Workers who haven't completed their profile or accepted their invite.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
        {workers.map(w => (
          <div key={w.id} style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div>
                <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>{w.name}</div>
                <div style={{ color: C.textMuted, fontSize: 12, marginTop: 2 }}>{w.email}</div>
                {w.job_title && <div style={{ color: C.textMuted, fontSize: 12 }}>{w.job_title}</div>}
              </div>
              <Badge label={w.app_status || 'Pending'} color={appStatusColor(w.app_status)} />
            </div>
            {w.mobile && <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 10 }}>📱 {w.mobile}</div>}
            <button onClick={() => handleRemind(w)} style={{ ...btnSmall, width: '100%' }}>📧 Send Reminder</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENT APPROVALS PAGE
// ═══════════════════════════════════════════════════════════════════════════════
function ClientApprovalsPage({ showToast }) {
  const [timesheets, setTimesheets] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('timesheets').select('*, workers(name)').order('created_at', { ascending: false }).limit(50);
    if (error) showToast(error.message, 'error');
    else setTimesheets(data || []);
    setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const handleMarkClientApproved = async (ts) => {
    const { error } = await supabase.from('timesheets').update({ client_approved: true }).eq('id', ts.id);
    if (error) showToast(error.message, 'error');
    else { showToast('Marked as client approved', 'success'); load(); }
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <Badge label="⚡ CLIENT APPROVAL TRACKING" color="blue" />
        <span style={{ color: C.textMuted, fontSize: 13 }}>Mark timesheets as client-approved before final payroll processing.</span>
      </div>
      {timesheets.length === 0 ? <EmptyState message="No timesheets found." /> : (
        <TableWrap>
          <thead><tr><Th>Worker</Th><Th>Client</Th><Th>Site</Th><Th>Date</Th><Th>Hours</Th><Th>Status</Th><Th>Client Approved</Th><Th>Actions</Th></tr></thead>
          <tbody>
            {timesheets.map(ts => (
              <tr key={ts.id}>
                <Td>{ts.workers?.name || '—'}</Td>
                <Td>{ts.client || '—'}</Td>
                <Td>{ts.site || '—'}</Td>
                <Td>{fmtDate(ts.date)}</Td>
                <Td>{ts.hours ?? '—'}</Td>
                <Td>{timesheetBadge(ts.status)}</Td>
                <Td>
                  {ts.client_approved
                    ? <Badge label="✓ Approved" color="green" />
                    : <Badge label="Pending" color="yellow" />}
                </Td>
                <Td>
                  {!ts.client_approved && (
                    <button onClick={() => handleMarkClientApproved(ts)} style={{ ...btnSmall, color: '#4ade80' }}>Mark Approved</button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAYROLL TRACKER PAGE
// ═══════════════════════════════════════════════════════════════════════════════
function PayrollTrackerPage({ showToast }) {
  const [timesheets, setTimesheets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase.from('timesheets').select('*, workers(name)').eq('status', 'approved').order('date', { ascending: false });
    if (dateFrom) q = q.gte('date', dateFrom);
    if (dateTo) q = q.lte('date', dateTo);
    const { data, error } = await q;
    if (error) showToast(error.message, 'error');
    else setTimesheets(data || []);
    setLoading(false);
  }, [showToast, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  const totalHours = timesheets.reduce((sum, ts) => sum + (parseFloat(ts.hours) || 0), 0);

  return (
    <div>
      <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 18, marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={{ color: C.textMuted, fontSize: 13, display: 'block', marginBottom: 4 }}>From</label>
            <input style={{ ...inputStyle, width: 160 }} type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div>
            <label style={{ color: C.textMuted, fontSize: 13, display: 'block', marginBottom: 4 }}>To</label>
            <input style={{ ...inputStyle, width: 160 }} type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </div>
          <button onClick={() => { setDateFrom(''); setDateTo(''); }} style={btnSecondary}>Clear</button>
          <div style={{ marginLeft: 'auto', background: C.card, borderRadius: 8, padding: '10px 20px', border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.warning }}>{totalHours.toFixed(1)}</div>
            <div style={{ color: C.textMuted, fontSize: 12 }}>Total Approved Hours</div>
          </div>
        </div>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : timesheets.length === 0 ? (
        <EmptyState message="No approved timesheets in this range." />
      ) : (
        <TableWrap>
          <thead><tr><Th>Worker</Th><Th>Date</Th><Th>Client</Th><Th>Site</Th><Th>Hours</Th><Th>Status</Th></tr></thead>
          <tbody>
            {timesheets.map(ts => (
              <tr key={ts.id}>
                <Td><strong>{ts.workers?.name || '—'}</strong></Td>
                <Td>{fmtDate(ts.date)}</Td>
                <Td>{ts.client || '—'}</Td>
                <Td>{ts.site || '—'}</Td>
                <Td><span style={{ fontWeight: 700, color: C.warning }}>{ts.hours}</span></Td>
                <Td>{timesheetBadge(ts.status)}</Td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} style={{ padding: '10px 16px', color: C.textMuted, fontSize: 13, borderTop: `2px solid ${C.border}` }}>{timesheets.length} records</td>
              <td style={{ padding: '10px 16px', fontWeight: 700, color: C.warning, fontSize: 15, borderTop: `2px solid ${C.border}` }}>{totalHours.toFixed(1)} hrs</td>
              <td style={{ borderTop: `2px solid ${C.border}` }} />
            </tr>
          </tfoot>
        </TableWrap>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// BULK MESSAGES PAGE
// ═══════════════════════════════════════════════════════════════════════════════
function BulkMessagesPage({ showToast }) {
  const [workerMsg, setWorkerMsg] = useState('');
  const [clientMsg, setClientMsg] = useState('');
  const [workers, setWorkers] = useState([]);
  const [clients, setClients] = useState([]);
  const [selectedWorkers, setSelectedWorkers] = useState([]);
  const [selectedClients, setSelectedClients] = useState([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    (async () => {
      const [w, c] = await Promise.all([
        supabase.from('workers').select('id, name, mobile, email').eq('app_status', 'Active').order('name'),
        supabase.from('clients').select('id, name, contact, contact_email, contact_phone').order('name'),
      ]);
      setWorkers(w.data || []);
      setClients(c.data || []);
    })();
  }, []);

  const toggleWorker = (id) => setSelectedWorkers(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const toggleClient = (id) => setSelectedClients(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const allWorkers = workers.length > 0 && selectedWorkers.length === workers.length;
  const allClients = clients.length > 0 && selectedClients.length === clients.length;

  const handleSendWorkers = async () => {
    if (!workerMsg.trim()) { showToast('Enter a message first.', 'error'); return; }
    if (!selectedWorkers.length) { showToast('Select at least one worker.', 'error'); return; }
    setSending(true);
    await new Promise(r => setTimeout(r, 800));
    showToast(`Message queued for ${selectedWorkers.length} worker(s)`, 'success');
    setWorkerMsg('');
    setSelectedWorkers([]);
    setSending(false);
  };

  const handleSendClients = async () => {
    if (!clientMsg.trim()) { showToast('Enter a message first.', 'error'); return; }
    if (!selectedClients.length) { showToast('Select at least one client.', 'error'); return; }
    setSending(true);
    await new Promise(r => setTimeout(r, 800));
    showToast(`Message queued for ${selectedClients.length} client(s)`, 'success');
    setClientMsg('');
    setSelectedClients([]);
    setSending(false);
  };

  const panelStyle = { background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
      {/* Worker Messages */}
      <div style={panelStyle}>
        <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>👷 Worker Messages</div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <label style={{ color: C.textMuted, fontSize: 13 }}>Recipients</label>
            <button onClick={() => setSelectedWorkers(allWorkers ? [] : workers.map(w => w.id))} style={{ ...btnSecondary, padding: '3px 10px', fontSize: 12 }}>{allWorkers ? 'Deselect All' : 'Select All'}</button>
          </div>
          <div style={{ maxHeight: 160, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 6, background: C.bg }}>
            {workers.map(w => (
              <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', borderBottom: `1px solid ${C.border}` }}>
                <input type="checkbox" checked={selectedWorkers.includes(w.id)} onChange={() => toggleWorker(w.id)} />
                <span style={{ color: C.text, fontSize: 13 }}>{w.name}</span>
                {w.mobile && <span style={{ color: C.textMuted, fontSize: 11 }}>{w.mobile}</span>}
              </label>
            ))}
            {workers.length === 0 && <div style={{ padding: 12, color: C.textMuted, fontSize: 13 }}>No active workers</div>}
          </div>
        </div>
        <Field label="Message">
          <textarea style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }} value={workerMsg} onChange={e => setWorkerMsg(e.target.value)} placeholder="Type your message to workers…" />
        </Field>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleSendWorkers} disabled={sending} style={{ ...btnPrimary, flex: 1 }}>📱 Send SMS</button>
          <button onClick={handleSendWorkers} disabled={sending} style={{ ...btnSecondary, flex: 1 }}>✉️ Send Email</button>
        </div>
      </div>

      {/* Client Messages */}
      <div style={panelStyle}>
        <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>🏗 Client Messages</div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <label style={{ color: C.textMuted, fontSize: 13 }}>Recipients</label>
            <button onClick={() => setSelectedClients(allClients ? [] : clients.map(c => c.id))} style={{ ...btnSecondary, padding: '3px 10px', fontSize: 12 }}>{allClients ? 'Deselect All' : 'Select All'}</button>
          </div>
          <div style={{ maxHeight: 160, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 6, background: C.bg }}>
            {clients.map(c => (
              <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', borderBottom: `1px solid ${C.border}` }}>
                <input type="checkbox" checked={selectedClients.includes(c.id)} onChange={() => toggleClient(c.id)} />
                <span style={{ color: C.text, fontSize: 13 }}>{c.name}</span>
                {c.contact && <span style={{ color: C.textMuted, fontSize: 11 }}>{c.contact}</span>}
              </label>
            ))}
            {clients.length === 0 && <div style={{ padding: 12, color: C.textMuted, fontSize: 13 }}>No clients added yet</div>}
          </div>
        </div>
        <Field label="Message">
          <textarea style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }} value={clientMsg} onChange={e => setClientMsg(e.target.value)} placeholder="Type your message to clients…" />
        </Field>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleSendClients} disabled={sending} style={{ ...btnPrimary, flex: 1 }}>📱 Send SMS</button>
          <button onClick={handleSendClients} disabled={sending} style={{ ...btnSecondary, flex: 1 }}>✉️ Send Email</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKER PORTAL
// ═══════════════════════════════════════════════════════════════════════════════
function WorkerPortal({ currentWorker, onSignOut, showToast, isMobile }) {
  const [activeTab, setActiveTab] = useState('allocations');

  const tabs = [
    { id: 'allocations', label: '📋 My Allocations' },
    { id: 'timesheets', label: '🕐 My Timesheets' },
    { id: 'certifications', label: '📜 My Certifications' },
    { id: 'clockin', label: '⏱ Clock In/Out' },
  ];

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      {/* Top bar */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: '0 20px', height: 56, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>CBD Plant & Labour</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: C.textMuted, fontSize: 13 }}>👤 {currentWorker?.name}</span>
          <button onClick={onSignOut} style={{ ...btnSecondary, padding: '6px 14px', fontSize: 13 }}>Sign Out</button>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, overflowX: 'auto', display: 'flex' }}>
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
            padding: '14px 20px', background: 'none', border: 'none', cursor: 'pointer',
            color: activeTab === tab.id ? C.accent : C.textMuted, fontSize: 14, fontWeight: activeTab === tab.id ? 600 : 400,
            borderBottom: `2px solid ${activeTab === tab.id ? C.accent : 'transparent'}`, whiteSpace: 'nowrap', transition: 'all 0.15s',
          }}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: isMobile ? 12 : 24, maxWidth: 900, margin: '0 auto' }}>
        {activeTab === 'allocations' && <WorkerAllocations currentWorker={currentWorker} showToast={showToast} />}
        {activeTab === 'timesheets' && <WorkerTimesheets currentWorker={currentWorker} showToast={showToast} />}
        {activeTab === 'certifications' && <WorkerCertifications currentWorker={currentWorker} showToast={showToast} />}
        {activeTab === 'clockin' && <WorkerClockIn currentWorker={currentWorker} showToast={showToast} />}
      </div>
    </div>
  );
}

// ─── Worker: My Allocations ───────────────────────────────────────────────────
function WorkerAllocations({ currentWorker, showToast }) {
  const [allocations, setAllocations] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data, error } = await supabase.from('allocations').select('*').eq('worker_id', currentWorker.id).order('created_at', { ascending: false });
      if (!mounted) return;
      if (error) showToast(error.message, 'error');
      else setAllocations(data || []);
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [currentWorker.id, showToast]);

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;
  if (!allocations.length) return <EmptyState message="No allocations found." />;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
      {allocations.map(a => (
        <div key={a.id} style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>{a.site || 'No site'}</div>
            {allocationBadge(a.status)}
          </div>
          <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 4 }}>Client: {a.client || '—'}</div>
          {a.project && <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 4 }}>Project: {a.project}</div>}
          {a.address && <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 4 }}>Address: {a.address}</div>}
          {a.site_manager && <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 4 }}>Site Manager: {a.site_manager}{a.manager_phone ? ` · ${a.manager_phone}` : ''}</div>}
          {a.start_date && <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 4 }}>Date: {a.start_date}</div>}
          <div style={{ color: C.textMuted, fontSize: 13 }}>Start: {fmtDateTime(a.start_time)}</div>
          {a.notes && <div style={{ color: C.textMuted, fontSize: 12, marginTop: 10, fontStyle: 'italic' }}>{a.notes}</div>}
        </div>
      ))}
    </div>
  );
}

// ─── Worker: My Timesheets ────────────────────────────────────────────────────
function WorkerTimesheets({ currentWorker, showToast }) {
  const [timesheets, setTimesheets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ client: '', site: '', date: todayISO(), hours: '', notes: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('timesheets').select('*').eq('worker_id', currentWorker.id).order('date', { ascending: false });
    if (error) showToast(error.message, 'error');
    else setTimesheets(data || []);
    setLoading(false);
  }, [currentWorker.id, showToast]);

  useEffect(() => { load(); }, [load]);

  const handleSubmit = async () => {
    if (!form.date || form.hours === '') { showToast('Date and hours are required.', 'error'); return; }
    setSaving(true);
    const { error } = await supabase.from('timesheets').insert([{ ...form, worker_id: currentWorker.id, status: 'pending', hours: parseFloat(form.hours) }]);
    if (error) showToast(error.message, 'error');
    else { showToast('Timesheet submitted successfully', 'success'); setModal(false); setForm({ client: '', site: '', date: todayISO(), hours: '', notes: '' }); load(); }
    setSaving(false);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
        <button onClick={() => setModal(true)} style={btnPrimary}>+ Submit Timesheet</button>
      </div>
      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : timesheets.length === 0 ? (
        <EmptyState message="No timesheets yet. Submit one to get started." />
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            {['all','pending','approved','rejected'].map(s => {
              const hrs = (s === 'all' ? timesheets : timesheets.filter(t => t.status === s)).reduce((a, t) => a + (parseFloat(t.hours) || 0), 0);
              return (
                <div key={s} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 16px', textAlign: 'center' }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: s === 'approved' ? C.success : s === 'rejected' ? C.error : s === 'pending' ? C.warning : C.text }}>{hrs.toFixed(1)}</div>
                  <div style={{ color: C.textMuted, fontSize: 11, textTransform: 'uppercase' }}>{s} hrs</div>
                </div>
              );
            })}
          </div>
          <TableWrap>
            <thead><tr><Th>Date</Th><Th>Client</Th><Th>Site</Th><Th>Hours</Th><Th>Status</Th></tr></thead>
            <tbody>
              {timesheets.map(ts => (
                <tr key={ts.id}>
                  <Td>{fmtDate(ts.date)}</Td>
                  <Td>{ts.client || '—'}</Td>
                  <Td>{ts.site || '—'}</Td>
                  <Td>{ts.hours}</Td>
                  <Td>{timesheetBadge(ts.status)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </>
      )}

      {modal && (
        <Modal title="Submit Timesheet" onClose={() => { setModal(false); setForm({ client: '', site: '', date: todayISO(), hours: '', notes: '' }); }}>
          <Field label="Date *"><input style={inputStyle} type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} /></Field>
          <Field label="Client"><input style={inputStyle} value={form.client} onChange={e => setForm(f => ({ ...f, client: e.target.value }))} /></Field>
          <Field label="Site"><input style={inputStyle} value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} /></Field>
          <Field label="Hours *"><input style={inputStyle} type="number" step="0.5" min="0" value={form.hours} onChange={e => setForm(f => ({ ...f, hours: e.target.value }))} /></Field>
          <Field label="Notes"><textarea style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></Field>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={() => { setModal(false); setForm({ client: '', site: '', date: todayISO(), hours: '', notes: '' }); }} style={btnSecondary}>Cancel</button>
            <button onClick={handleSubmit} disabled={saving} style={btnPrimary}>{saving ? 'Submitting…' : 'Submit'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Worker: My Certifications ────────────────────────────────────────────────
function WorkerCertifications({ currentWorker, showToast }) {
  const [certs, setCerts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data, error } = await supabase.from('certifications').select('*').eq('worker_id', currentWorker.id).order('expiry', { ascending: true });
      if (!mounted) return;
      if (error) showToast(error.message, 'error');
      else setCerts(data || []);
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [currentWorker.id, showToast]);

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;
  if (!certs.length) return <EmptyState message="No certifications on file." />;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
      {certs.map(c => (
        <div key={c.id} style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
            <div style={{ fontWeight: 700, color: C.text, fontSize: 15 }}>{c.cert_name}</div>
            {certBadge(c.expiry)}
          </div>
          {c.issuer && <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 4 }}>Issuer: {c.issuer}</div>}
          <div style={{ color: C.textMuted, fontSize: 13 }}>Expiry: {fmtDate(c.expiry)}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Worker: Clock In/Out ─────────────────────────────────────────────────────
function WorkerClockIn({ currentWorker, showToast }) {
  const [now, setNow] = useState(new Date());
  const storageKey = `clockIn_${currentWorker.id}`;
  const [clockInTime, setClockInTime] = useState(() => {
    const stored = localStorage.getItem(storageKey);
    return stored ? new Date(stored) : null;
  });
  const [saving, setSaving] = useState(false);
  const [todayEntries, setTodayEntries] = useState([]);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const loadToday = useCallback(async () => {
    const { data } = await supabase.from('timesheets').select('*')
      .eq('worker_id', currentWorker.id)
      .eq('date', todayISO())
      .order('created_at', { ascending: false });
    setTodayEntries(data || []);
  }, [currentWorker.id]);

  useEffect(() => { loadToday(); }, [loadToday]);

  const handleClockIn = () => {
    const t = new Date();
    setClockInTime(t);
    localStorage.setItem(storageKey, t.toISOString());
    showToast(`Clocked in at ${t.toLocaleTimeString('en-AU', { timeStyle: 'short' })}`, 'success');
  };

  const handleClockOut = async () => {
    if (!clockInTime) return;
    const out = new Date();
    const hours = Math.round(((out - clockInTime) / (1000 * 60 * 60)) * 100) / 100;
    setSaving(true);
    const { error } = await supabase.from('timesheets').insert([{
      worker_id: currentWorker.id,
      date: todayISO(),
      start_time: clockInTime.toISOString(),
      end_time: out.toISOString(),
      hours,
      status: 'pending',
    }]);
    if (error) { showToast(error.message, 'error'); }
    else {
      showToast(`Clocked out — ${hours} hours logged`, 'success');
      localStorage.removeItem(storageKey);
      setClockInTime(null);
      loadToday();
    }
    setSaving(false);
  };

  const elapsed = clockInTime ? Math.floor((now - clockInTime) / 1000) : 0;
  const elapsedStr = clockInTime ? `${String(Math.floor(elapsed / 3600)).padStart(2, '0')}:${String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}` : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 24 }}>
      <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, padding: '32px 40px', textAlign: 'center', maxWidth: 380, width: '100%' }}>
        <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 8 }}>{now.toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
        <div style={{ fontSize: 44, fontWeight: 800, color: C.text, fontVariantNumeric: 'tabular-nums', letterSpacing: 2 }}>
          {now.toLocaleTimeString('en-AU', { timeStyle: 'medium' })}
        </div>

        {clockInTime && (
          <div style={{ marginTop: 16, padding: '8px 16px', background: '#16653a', borderRadius: 8 }}>
            <div style={{ color: '#4ade80', fontSize: 13 }}>Clocked in at {clockInTime.toLocaleTimeString('en-AU', { timeStyle: 'short' })}</div>
            <div style={{ color: '#4ade80', fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{elapsedStr}</div>
          </div>
        )}

        <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!clockInTime ? (
            <button onClick={handleClockIn} style={{ ...btnPrimary, background: C.success, fontSize: 16, padding: '14px 0', borderRadius: 8 }}>
              ▶ Clock In
            </button>
          ) : (
            <button onClick={handleClockOut} disabled={saving} style={{ ...btnPrimary, background: C.error, fontSize: 16, padding: '14px 0', borderRadius: 8 }}>
              {saving ? 'Saving…' : '■ Clock Out'}
            </button>
          )}
        </div>
      </div>

      {todayEntries.length > 0 && (
        <div style={{ marginTop: 28, width: '100%', maxWidth: 380 }}>
          <h4 style={{ color: C.textMuted, fontSize: 13, marginBottom: 12, textTransform: 'uppercase' }}>Today's entries</h4>
          {todayEntries.map(e => (
            <div key={e.id} style={{ background: C.card, borderRadius: 8, border: `1px solid ${C.border}`, padding: '12px 16px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ color: C.text, fontWeight: 600 }}>{e.hours} hrs</span>
                {e.start_time && <span style={{ color: C.textMuted, fontSize: 12, marginLeft: 8 }}>{fmtDateTime(e.start_time)} → {fmtDateTime(e.end_time)}</span>}
              </div>
              {timesheetBadge(e.status)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
