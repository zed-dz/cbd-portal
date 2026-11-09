// xeroTokens.ts — the ONE way edge functions touch Xero tokens (2026-11-09).
//
// CANONICAL COPY: supabase/functions/_shared/xeroTokens.ts. The deploy script
// uploads only the *.ts files inside a function's own folder, so every xero-*
// function (and books-sync) carries a byte-identical copy named xeroTokens.ts.
// Edit this file, then re-copy it into each folder (see the report / DOCS).
//
// Tokens are encrypted at rest in Supabase Vault (migration
// 20261109_xero_tokens_vault.sql). Nothing here reads xero_tokens.access_token
// or refresh_token directly — those columns are NULL now. Everything goes
// through four service-role-only SQL functions:
//   xero_tokens_read()          → getTokens()
//   xero_tokens_write(...)      → saveTokens()
//   xero_token_begin_refresh / xero_token_finish_refresh / xero_token_abort_refresh
//                               → withRefreshLock()   (30 s lease on the row, so two
//                                 functions never spend the same refresh token)
//
// withRefreshLock(sb, clientId, clientSecret, minValidSeconds = 300):
//   fresh   → use the stored access token (more than minValidSeconds left)
//   busy    → someone else is refreshing: wait and ask again (up to ~10 s)
//   refresh → we hold the lease: call Xero, then store via finish_refresh
// If Xero refuses the refresh token (another caller rotated it just before us),
// the row is read again and the refresh is retried ONCE with whatever is there.
// Returns the access token, or null when Xero is not connected or the sign-in
// can no longer be refreshed (callers keep their own "reconnect" message).
// Never log a token.

// deno-lint-ignore no-explicit-any
type Sb = any;

export type XeroTokens = {
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  tenant_id: string | null;
  scope: string | null;
  connected_by: string | null;
  updated_at: string | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Everything about the connection, secrets included. Service role only.
export async function getTokens(sb: Sb): Promise<XeroTokens | null> {
  const { data, error } = await sb.rpc('xero_tokens_read');
  if (error) { console.error('xero_tokens_read failed:', error.message); return null; }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    access_token: row.access_token ?? null,
    refresh_token: row.refresh_token ?? null,
    expires_at: row.expires_at ?? null,
    tenant_id: row.tenant_id ?? null,
    scope: row.scope ?? null,
    connected_by: row.connected_by ?? null,
    updated_at: row.updated_at ?? null,
  };
}

// The non-secret half (tenant, scope, expiry) — for "is Xero connected / which
// scopes" checks. Reads the table's plain columns, never a token.
export async function getXeroMeta(sb: Sb): Promise<{ connected: boolean; tenant_id: string | null; scope: string; expires_at: string | null }> {
  const { data } = await sb.from('xero_tokens').select('tenant_id, scope, expires_at').eq('id', 1).maybeSingle();
  return { connected: !!data?.tenant_id, tenant_id: data?.tenant_id ?? null, scope: String(data?.scope || ''), expires_at: data?.expires_at ?? null };
}

// Store a brand-new pair (OAuth callback). Clears any refresh lease.
export async function saveTokens(sb: Sb, t: { access_token: string; refresh_token: string; expires_at: string; tenant_id: string | null; scope: string | null; connected_by?: string | null }): Promise<string | null> {
  const { error } = await sb.rpc('xero_tokens_write', {
    p_access: t.access_token, p_refresh: t.refresh_token, p_expires: t.expires_at,
    p_tenant: t.tenant_id, p_scope: t.scope, p_connected_by: t.connected_by ?? null,
  });
  if (error) { console.error('xero_tokens_write failed:', error.message); return error.message; }
  return null;
}

// Scope check that accepts both the broad and the granular (.read) form.
export function hasScope(scope: string, name: string): boolean {
  const s = ` ${String(scope || '')} `;
  return s.includes(` ${name} `) || s.includes(` ${name}.read `) || s.includes(` ${name.replace(/\.read$/, '')} `);
}

export async function withRefreshLock(sb: Sb, clientId: string, clientSecret: string, minValidSeconds = 300): Promise<string | null> {
  const holder = crypto.randomUUID();
  let failedRefresh: string | null = null;   // the refresh token Xero already refused
  for (let attempt = 0; attempt < 25; attempt++) {
    const { data, error } = await sb.rpc('xero_token_begin_refresh', { p_holder: holder, p_min_valid_seconds: minValidSeconds });
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
    // deno-lint-ignore no-explicit-any
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

// Back-compat name used by the existing xero-* functions.
export const getXeroAccessToken = withRefreshLock;
