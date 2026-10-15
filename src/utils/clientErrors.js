// Client-side error reporting (pre-trial safety measure).
// Every uncaught error, unhandled promise rejection and React render crash is
// written to `client_errors` so the office can see what broke on which phone,
// without asking the worker to describe it. Throttled: max 5 reports a minute
// per tab and no repeat of the same message within 5 minutes.

import { supabase } from '../supabaseClient';

const seen = new Map();
let sentThisMinute = 0;
let minuteStart = Date.now();

const IGNORE = [/ResizeObserver loop/i, /Loading chunk \d+ failed/i, /Script error\.?$/i];

export async function reportClientError(error, extra = {}) {
  try {
    const message = String(error?.message || error || 'Unknown error').slice(0, 500);
    if (IGNORE.some(re => re.test(message))) return;
    const stack = String(error?.stack || '').slice(0, 4000);
    const now = Date.now();
    if (now - minuteStart > 60_000) { minuteStart = now; sentThisMinute = 0; }
    if (sentThisMinute >= 5) return;
    const key = message.slice(0, 120);
    if (seen.has(key) && now - seen.get(key) < 5 * 60_000) return;
    seen.set(key, now);
    sentThisMinute += 1;

    const { data } = await supabase.auth.getSession();
    const email = data?.session?.user?.email || null;
    if (!email) return;   // table is insert-only for signed-in users

    await supabase.from('client_errors').insert({
      user_email: email,
      page: (typeof window !== 'undefined' && window.__portalPage) || null,
      message,
      stack,
      url: String(window.location.href || '').slice(0, 500),
      user_agent: String(navigator.userAgent || '').slice(0, 300),
      extra: { ...extra, viewport: `${window.innerWidth}x${window.innerHeight}`, online: navigator.onLine },
    });
  } catch {
    // The reporter must never throw.
  }
}

export function installGlobalErrorHandlers() {
  if (typeof window === 'undefined' || window.__cbdErrorHandlers) return;
  window.__cbdErrorHandlers = true;
  window.addEventListener('error', (e) => {
    if (e?.error) reportClientError(e.error, { source: 'window.onerror' });
    else if (e?.message) reportClientError(new Error(e.message), { source: 'window.onerror', file: e.filename, line: e.lineno });
  });
  window.addEventListener('unhandledrejection', (e) => {
    reportClientError(e?.reason || new Error('Unhandled promise rejection'), { source: 'unhandledrejection' });
  });
}
