// xeroToken.ts — the ONE Xero access-token getter (2026-10-20).
// Identical copies live in xero-invoice-sync/, xero-invoice/, xero-data/ and
// xero-push/ (each function deploys its own folder). Edit all four together.
//
// Xero rotates the refresh token on every refresh, so two functions refreshing
// at the same moment would spend the same token twice and one of them would
// fail (or worse, store a pair that is already dead). The lock lives in SQL
// (migration 20261020_audit_fixes.sql): xero_token_begin_refresh() takes a
// 30-second lease on the single xero_tokens row under SELECT ... FOR UPDATE.
//   fresh   → use the stored access token (more than 5 minutes left)
//   busy    → someone else is refreshing: wait and ask again (up to ~10 s)
//   refresh → we hold the lease: call Xero, then store via
//             xero_token_finish_refresh() (or release via _abort_refresh).
// If Xero refuses the refresh token (another caller rotated it just before us),
// the row is read again and the refresh is retried ONCE with whatever is there.
// Returns the access token, or null when Xero is not connected or the sign-in
// can no longer be refreshed (callers keep their existing "reconnect" message).

// deno-lint-ignore no-explicit-any
type Sb = any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getXeroAccessToken(sb: Sb, clientId: string, clientSecret: string): Promise<string | null> {
  const holder = crypto.randomUUID();
  let failedRefresh: string | null = null;   // the refresh token Xero already refused
  for (let attempt = 0; attempt < 25; attempt++) {
    const { data, error } = await sb.rpc('xero_token_begin_refresh', { p_holder: holder, p_min_valid_seconds: 300 });
    if (error || !data) { console.error('xero token read failed:', error?.message || 'no data'); return null; }
    if (data.state === 'missing') return null;
    if (data.state === 'fresh') return String(data.access_token);
    if (data.state === 'busy') { await sleep(400); continue; }

    // state 'refresh': we hold the lease.
    const spent = String(data.refresh_token || '');
    if (!spent || spent === failedRefresh) {
      await sb.rpc('xero_token_abort_refresh', { p_holder: holder });
      return null;   // the stored token is the one Xero already refused: really expired
    }
    let tokens: any = null;
    try {
      const res = await fetch('https://identity.xero.com/connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${btoa(`${clientId}:${clientSecret}`)}` },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: spent }),
      });
      if (res.ok) tokens = await res.json();
      else console.error('xero token refresh refused:', res.status);
    } catch (e) {
      console.error('xero token refresh failed:', (e as Error)?.message);
    }
    if (tokens?.access_token && tokens?.refresh_token) {
      const { error: fErr } = await sb.rpc('xero_token_finish_refresh', {
        p_holder: holder, p_old_refresh: spent, p_access: tokens.access_token,
        p_refresh: tokens.refresh_token, p_expires_in: Number(tokens.expires_in) || 1800,
      });
      if (fErr) console.error('xero token store failed:', fErr.message);
      return String(tokens.access_token);
    }
    // Refused: release the lease, re-read once (another caller may have
    // rotated the pair in the meantime) and try again with what is stored.
    await sb.rpc('xero_token_abort_refresh', { p_holder: holder });
    if (failedRefresh !== null) return null;
    failedRefresh = spent;
  }
  console.error('xero token: gave up waiting for another refresh');
  return null;
}
