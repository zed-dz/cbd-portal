import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from './supabaseClient';
import { WORKER_SAFE_COLS } from './utils/workerCols';
import { C, btnSecondary } from './theme';
import { ToastContainer, Spinner } from './components';
import { LoginPage } from './pages/Login/LoginPage';
import { SetPasswordPage } from './pages/Login/SetPasswordPage';
import { MfaChallengePage } from './pages/Login/MfaChallengePage';
import { AdminPortal } from './portals/AdminPortal';
import { WorkerPortal } from './portals/WorkerPortal';
import { PublicProfilePage } from './pages/PublicProfile/PublicProfilePage';
import { OnboardProfilePage } from './pages/OnboardProfile/OnboardProfilePage';
import { ApplyPage } from './pages/Apply/ApplyPage';
import { ClientApprovePage } from './pages/ClientApprove/ClientApprovePage';
import { OmniHelpBubble } from './components/help/OmniHelpBubble';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OfflineBanner } from './components/OfflineBanner';
import { installGlobalErrorHandlers } from './utils/clientErrors';

const PUBLIC_ROUTE_PATTERNS = [
  { kind: 'profile',  re: /^\/p\/([0-9a-f-]{36})\/?$/i },
  { kind: 'onboard',  re: /^\/onboard\/([0-9a-f-]{36})\/?$/i },
  { kind: 'apply',    re: /^\/apply\/?$/i },
  { kind: 'approvets', re: /^\/approve-ts\/([0-9a-f-]{36})\/?$/i },
];

function matchPublicRoute(pathname) {
  for (const r of PUBLIC_ROUTE_PATTERNS) {
    const m = pathname.match(r.re);
    if (m) return { kind: r.kind, token: m[1] };
  }
  return null;
}

// Emailed auth links land here as `#access_token=…&type=recovery|invite|magiclink`
// (or `#error=…&error_description=…` when the link is dead). supabase-js wipes
// the hash while it signs the person in, so read it ONCE at module load —
// module code runs before any of that async work can touch the URL.
const ENTRY_AUTH = (() => {
  try {
    const hash = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
    const query = new URLSearchParams(window.location.search || '');
    const type = hash.get('type') || query.get('type') || null;
    const errDesc = hash.get('error_description') || query.get('error_description') || null;
    const errCode = hash.get('error_code') || query.get('error_code') || null;
    return { type, errDesc, errCode };
  } catch {
    return { type: null, errDesc: null, errCode: null };
  }
})();
const PASSWORD_LINK_TYPES = ['recovery', 'invite', 'magiclink'];
const ENTRY_LINK_NOTICE = ENTRY_AUTH.errDesc
  ? (/expired|invalid/i.test(`${ENTRY_AUTH.errCode} ${ENTRY_AUTH.errDesc}`)
      ? 'That email link has expired or was already used. Enter your email and tap “Forgot your password?” to get a fresh one.'
      : ENTRY_AUTH.errDesc.replace(/\+/g, ' '))
  : '';

function GlobalStyles() {
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap';
    document.head.appendChild(link);

    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; }
      body {
        background: ${C.bg}; color: ${C.text};
        font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-feature-settings: 'cv11', 'ss01';
      }

      /* Animations */
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes modalIn {
        from { opacity: 0; transform: translateY(-8px) scale(0.98); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes toastIn {
        from { opacity: 0; transform: translateX(20px); }
        to   { opacity: 1; transform: translateX(0); }
      }
      @keyframes slideIn {
        from { transform: translateX(40px); opacity: 0; }
        to   { transform: translateX(0); opacity: 1; }
      }

      /* Forms */
      input, select, textarea { font-family: inherit; }
      input:focus, select:focus, textarea:focus {
        border-color: ${C.accent} !important;
        box-shadow: 0 0 0 3px rgba(249,115,22,0.18);
      }
      input::placeholder, textarea::placeholder { color: ${C.textDim}; }
      input[type="checkbox"], input[type="radio"] { accent-color: ${C.accent}; cursor: pointer; }

      /* Buttons */
      button { font-family: inherit; }
      button:disabled { opacity: 0.5; cursor: not-allowed !important; }
      button:not(:disabled):active { transform: translateY(0.5px); }
      button:focus-visible { outline: 2px solid ${C.accent}; outline-offset: 2px; }

      /* Table row hover affordance */
      tbody tr { transition: background 120ms; }
      tbody tr:hover { background: ${C.cardHover}; }

      /* Selection */
      ::selection { background: rgba(249,115,22,0.32); color: ${C.text}; }

      /* Scrollbar — slim, theme-aware */
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 4px; border: 2px solid transparent; background-clip: padding-box; }
      ::-webkit-scrollbar-thumb:hover { background: ${C.borderStrong}; border: 2px solid transparent; background-clip: padding-box; }
      * { scrollbar-width: thin; scrollbar-color: ${C.border} transparent; }

      /* Links — keep subtle */
      a { color: ${C.accent}; text-decoration: none; }
      a:hover { text-decoration: underline; }

      /* Auto-fill background fix for dark inputs (Chrome) */
      input:-webkit-autofill,
      input:-webkit-autofill:focus {
        -webkit-text-fill-color: ${C.text};
        -webkit-box-shadow: 0 0 0px 1000px ${C.bg} inset;
        transition: background-color 5000s ease-in-out 0s;
      }
    `;
    document.head.appendChild(style);
    return () => { document.head.removeChild(style); document.head.removeChild(link); };
  }, []);
  return null;
}

export default function App() {
  const publicRoute = matchPublicRoute(window.location.pathname);
  useEffect(() => { installGlobalErrorHandlers(); }, []);
  if (publicRoute) {
    return (
      <ErrorBoundary>
        <GlobalStyles />
        <OfflineBanner />
        {publicRoute.kind === 'profile' ? <PublicProfilePage token={publicRoute.token} />
         : publicRoute.kind === 'onboard' ? <OnboardProfilePage token={publicRoute.token} />
         : publicRoute.kind === 'apply'   ? <ApplyPage />
         : publicRoute.kind === 'approvets' ? <ClientApprovePage token={publicRoute.token} />
         : null}
      </ErrorBoundary>
    );
  }
  return (
    <ErrorBoundary>
      <GlobalStyles />
      <OfflineBanner />
      <AppShell />
    </ErrorBoundary>
  );
}

function AppShell() {
  const [session, setSession] = useState(null);
  const [currentWorker, setCurrentWorker] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  // Set when the person arrived through an emailed link (reset / invite /
  // sign-in link) or when Supabase fires PASSWORD_RECOVERY: shows the
  // Set-password screen before anything else.
  const [needsPassword, setNeedsPassword] = useState(PASSWORD_LINK_TYPES.includes(ENTRY_AUTH.type) ? ENTRY_AUTH.type : null);
  // Two-step login gate: 'idle' (no session) → 'checking' → 'required' (show
  // the code screen) | 'clear' (portal). `mfaFirst` flips the order when a
  // password update was refused at aal1 (Supabase wants the code first).
  const [mfaGate, setMfaGate] = useState('idle');
  const [mfaFirst, setMfaFirst] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [toasts, setToasts] = useState([]);
  const toastId = useRef(0);
  const lastFetchedEmail = useRef(null);

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
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), type === 'error' ? 6500 : 3000);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const fetchWorker = useCallback(async (email) => {
    // Case-insensitive match (RLS and every function use lower()); `_` and `%`
    // are escaped so an email with an underscore cannot match another row.
    // Archived people get "No worker profile found" instead of a stale portal.
    const pattern = String(email || '').replace(/[\\%_]/g, m => '\\' + m);
    const { data, error } = await supabase.from('workers').select(WORKER_SAFE_COLS)
      .ilike('email', pattern).is('archived_at', null).order('created_at', { ascending: true }).limit(1);
    if (error) { showToast('Could not load profile: ' + error.message, 'error'); }
    setCurrentWorker(data?.[0] ?? null);
    setAuthLoading(false);
  }, [showToast]);

  // Handle Xero OAuth redirect back to portal
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('xero_connected') === '1') {
      showToast('Xero connected successfully!', 'success');
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('xero_error')) {
      showToast(`Xero connection failed: ${params.get('xero_error')}`, 'error');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [showToast]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) { lastFetchedEmail.current = session.user.email; fetchWorker(session.user.email); }
      else setAuthLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') setNeedsPassword('recovery');
      setSession(session);
      if (!session) {
        lastFetchedEmail.current = null;
        setCurrentWorker(null);
        setAuthLoading(false);
        return;
      }
      // Supabase fires SIGNED_IN / TOKEN_REFRESHED whenever the tab regains
      // focus or the access token auto-refreshes. Re-fetching the worker on
      // every one of those re-shows the loading spinner and reloads the page.
      // Only refetch when the signed-in user actually changes.
      if (lastFetchedEmail.current === session.user.email) return;
      lastFetchedEmail.current = session.user.email;
      setAuthLoading(true);
      fetchWorker(session.user.email);
    });

    return () => subscription.unsubscribe();
  }, [fetchWorker]);

  // Profile edits (e.g. notification settings) ask for a fresh currentWorker.
  useEffect(() => {
    const onUpdated = () => { if (lastFetchedEmail.current) fetchWorker(lastFetchedEmail.current); };
    window.addEventListener('cbd:worker-updated', onUpdated);
    return () => window.removeEventListener('cbd:worker-updated', onUpdated);
  }, [fetchWorker]);

  // Once a session exists, ask Supabase whether this person has a verified
  // authenticator and the current token has not passed it yet (aal1 → aal2).
  // Keyed on the user id so token refreshes / tab focus do not re-run it; the
  // code screen's onDone flips the gate to 'clear' after a successful verify.
  const sessionUserId = session?.user?.id || null;
  useEffect(() => {
    if (!sessionUserId) { setMfaGate('idle'); setMfaFirst(false); return; }
    let cancelled = false;
    setMfaGate('checking');
    (async () => {
      let required = false;
      try {
        const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        required = aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2';
        if (!required && aal?.currentLevel !== 'aal2') {
          // Belt and braces: the JWT may predate a freshly enrolled factor.
          const { data: f } = await supabase.auth.mfa.listFactors();
          required = (f?.totp || []).some(x => x.status === 'verified');
        }
      } catch { required = false; }
      if (!cancelled) setMfaGate(required ? 'required' : 'clear');
    })();
    return () => { cancelled = true; };
  }, [sessionUserId]);

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

  // Keep the spinner up while the two-step check runs so the portal (or the
  // "No worker profile" screen) never flashes before the code screen.
  const mfaPending = !!session && !needsPassword && (mfaGate === 'idle' || mfaGate === 'checking');
  if (authLoading || mfaPending) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg }}>
        <Spinner size={40} />
      </div>
    );
  }

  return (
    <>
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      {session && currentWorker && !needsPassword && mfaGate === 'clear' && <OmniHelpBubble />}
      {!session ? (
        <LoginPage
          email={loginEmail} setEmail={setLoginEmail}
          password={loginPassword} setPassword={setLoginPassword}
          error={loginError} loading={loginLoading}
          onSubmit={handleLogin}
          startNotice={ENTRY_LINK_NOTICE}
        />
      ) : needsPassword && !mfaFirst ? (
        <SetPasswordPage
          kind={needsPassword}
          email={session.user?.email}
          showToast={showToast}
          onDone={() => {
            setNeedsPassword(null);
            try { window.history.replaceState({}, '', window.location.pathname); } catch { /* ignore */ }
          }}
          onSignOut={async () => { setNeedsPassword(null); await handleSignOut(); }}
          onNeedsMfa={() => { setMfaFirst(true); setMfaGate('required'); }}
        />
      ) : mfaGate === 'required' ? (
        <MfaChallengePage
          email={session.user?.email}
          showToast={showToast}
          onDone={() => {
            setMfaGate('clear'); setMfaFirst(false);
            // The profile lookup ran before the code, while the database still
            // refused this session (aal1); read it again now that the token is aal2.
            if (lastFetchedEmail.current) { setAuthLoading(true); fetchWorker(lastFetchedEmail.current); }
          }}
          onSignOut={async () => { setMfaFirst(false); await handleSignOut(); }}
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
