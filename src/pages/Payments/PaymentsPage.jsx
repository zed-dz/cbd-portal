import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary, btnSmall } from '../../theme';
import { Field, Spinner, TableWrap, Th, Td, EmptyState } from '../../components';

const money = (cents, ccy = 'aud') =>
  `${(ccy || 'aud').toUpperCase()} ${((cents || 0) / 100).toFixed(2)}`;

// Admin Payments page: Stripe connection status + invoice-a-client + pay-workers.
// Every write path runs as a DRY RUN first; the operator must explicitly confirm
// to run it for real. The LIVE Stripe key never touches the browser — these call
// admin-gated Edge Functions that read it from integration_secrets server-side.
export function PaymentsPage({ showToast }) {
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    const { data, error } = await supabase.functions.invoke('stripe-status', { body: {} });
    if (error) { setStatus({ connected: false, error: error.message }); }
    else setStatus(data);
    setStatusLoading(false);
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  return (
    <div style={{ maxWidth: 920, margin: '0 auto' }}>
      <h2 style={{ color: C.text, marginBottom: 6 }}>💳 Payments</h2>
      <div style={{ color: C.textMuted, fontSize: 13, marginBottom: 20 }}>
        Invoice clients and pay workers via Stripe, driven by approved timesheets.
      </div>

      <StripeStatusCard status={status} loading={statusLoading} onRefresh={loadStatus} />
      <InvoiceClientCard showToast={showToast} />
      <PayWorkersCard showToast={showToast} status={status} />
      <HistoryCard />
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20, marginBottom: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 12 }}>{title}</div>
      {children}
    </div>
  );
}

function StripeStatusCard({ status, loading, onRefresh }) {
  return (
    <Card title="Stripe connection">
      {loading ? <Spinner /> : !status ? <div style={{ color: C.textMuted }}>—</div> : status.connected === false ? (
        <div>
          <div style={{ color: C.error, fontSize: 13 }}>Not connected: {status.error || 'unknown error'}</div>
          <div style={{ color: C.textMuted, fontSize: 12, marginTop: 8 }}>
            Store the Stripe secret key in <code>integration_secrets</code> (key <code>stripe_secret_key</code>) — service-role only.
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px,1fr))', gap: 12, fontSize: 13 }}>
          <Stat label="Account" value={status.account_id} />
          <Stat label="Business" value={status.business_name || '—'} />
          <Stat label="Country / currency" value={`${status.country || '—'} / ${(status.default_currency || '').toUpperCase()}`} />
          <Stat label="Charges enabled" value={status.charges_enabled ? 'Yes' : 'No'} good={status.charges_enabled} />
          <Stat label="Payouts enabled" value={status.payouts_enabled ? 'Yes' : 'No'} good={status.payouts_enabled} />
          <Stat label="Available balance" value={(status.available || []).map(b => `${b.amount/100} ${b.currency?.toUpperCase()}`).join(', ') || '—'} />
          {status.payout_requirements && (
            <div style={{ gridColumn: '1 / -1', color: C.warning, fontSize: 12 }}>⚠ {status.payout_requirements}</div>
          )}
        </div>
      )}
      <button onClick={onRefresh} style={{ ...btnSmall, marginTop: 12 }}>Refresh</button>
    </Card>
  );
}

function Stat({ label, value, good }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: good === true ? C.success : good === false ? C.error : C.text }}>{value}</div>
    </div>
  );
}

function InvoiceClientCard({ showToast }) {
  const [clients, setClients] = useState([]);
  const [f, setF] = useState({ client: '', periodFrom: '', periodTo: '' });
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    supabase.from('clients').select('name').order('name').then(({ data }) => setClients((data || []).map(c => c.name).filter(Boolean)));
  }, []);

  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));

  const run = async (dry_run) => {
    if (!f.client || !f.periodFrom || !f.periodTo) { showToast('Client and period are required.', 'error'); return; }
    if (!dry_run && !window.confirm(`Create a REAL Stripe invoice for ${f.client}? This will be sent to the client.`)) return;
    setBusy(true);
    const { data, error } = await supabase.functions.invoke('stripe-invoice-client', { body: { ...f, dry_run } });
    setBusy(false);
    if (error) { showToast(error.message, 'error'); return; }
    setPreview(data);
    if (data.error) showToast(data.error, 'error');
    else if (!dry_run && data.ok) showToast('Invoice created in Stripe.', 'success');
  };

  return (
    <Card title="Invoice a client (from approved timesheets)">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <Field label="Client">
          <input style={inputStyle} list="pay-clients" value={f.client} onChange={set('client')} placeholder="Select…" />
          <datalist id="pay-clients">{clients.map(c => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Period from"><input type="date" style={inputStyle} value={f.periodFrom} onChange={set('periodFrom')} /></Field>
        <Field label="Period to"><input type="date" style={inputStyle} value={f.periodTo} onChange={set('periodTo')} /></Field>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
        <button onClick={() => run(true)} disabled={busy} style={btnSecondary}>{busy ? 'Working…' : 'Preview (dry run)'}</button>
        <button onClick={() => run(false)} disabled={busy || !preview?.ok} style={btnPrimary} title={preview?.ok ? '' : 'Run a successful dry run first'}>Create invoice for real</button>
      </div>
      {preview && <PreviewBlock preview={preview} />}
    </Card>
  );
}

function PayWorkersCard({ showToast, status }) {
  const [f, setF] = useState({ periodFrom: '', periodTo: '' });
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));

  const run = async (dry_run) => {
    if (!f.periodFrom || !f.periodTo) { showToast('Period is required.', 'error'); return; }
    if (!dry_run && !window.confirm('Run a REAL payment run? Workers with a Stripe Connect account will be transferred funds.')) return;
    setBusy(true);
    const { data, error } = await supabase.functions.invoke('stripe-pay-workers', { body: { ...f, dry_run } });
    setBusy(false);
    if (error) { showToast(error.message, 'error'); return; }
    setPreview(data);
    if (data.error) showToast(data.error, 'error');
    else if (!dry_run && data.ok) showToast('Payment run completed.', 'success');
  };

  return (
    <Card title="Pay workers (from approved timesheets)">
      {status && status.payouts_enabled === false && (
        <div style={{ color: C.warning, fontSize: 12, marginBottom: 10 }}>
          ⚠ Stripe payouts/transfers are not yet enabled on this account. Real transfers will fail until Stripe verification is complete — dry-run previews still work.
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Period from"><input type="date" style={inputStyle} value={f.periodFrom} onChange={set('periodFrom')} /></Field>
        <Field label="Period to"><input type="date" style={inputStyle} value={f.periodTo} onChange={set('periodTo')} /></Field>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
        <button onClick={() => run(true)} disabled={busy} style={btnSecondary}>{busy ? 'Working…' : 'Preview (dry run)'}</button>
        <button onClick={() => run(false)} disabled={busy || !preview} style={btnPrimary}>Run payment for real</button>
      </div>
      {preview && <PreviewBlock preview={preview} pay />}
    </Card>
  );
}

function PreviewBlock({ preview, pay }) {
  return (
    <div style={{ marginTop: 14, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14 }}>
      {preview.dry_run && <div style={{ color: C.warning, fontSize: 12, marginBottom: 8 }}>DRY RUN — nothing was charged or transferred.</div>}
      {preview.error && <div style={{ color: C.error, fontSize: 13 }}>{preview.error}</div>}
      {pay ? (
        <>
          <div style={{ fontSize: 13, color: C.text, marginBottom: 8 }}>
            {preview.worker_count || 0} worker(s) · total {money(preview.total_cents, preview.currency)}
            {preview.run_id ? ` · run ${preview.run_id.slice(0, 8)} (${preview.run_status})` : ''}
          </div>
          {preview.note_connect && <div style={{ color: C.warning, fontSize: 12, marginBottom: 8 }}>⚠ {preview.note_connect}</div>}
          {(preview.plan || preview.results || []).length > 0 && (
            <TableWrap>
              <thead><tr><Th>Worker</Th><Th>Sheets</Th><Th>Amount</Th><Th>Method</Th><Th>Status</Th></tr></thead>
              <tbody>
                {(preview.results || preview.plan).map((p, i) => (
                  <tr key={i}>
                    <Td>{p.worker_name}</Td><Td>{p.timesheet_count}</Td>
                    <Td>{money(p.amount_cents, preview.currency)}</Td>
                    <Td>{p.method === 'stripe_transfer' ? 'Stripe transfer' : 'Manual (no Connect)'}</Td>
                    <Td>{p.status || (preview.dry_run ? 'planned' : '—')}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </>
      ) : preview.breakdown ? (
        <div style={{ fontSize: 13, color: C.text }}>
          <div>{preview.breakdown.client} · {preview.breakdown.total_charge_hours}h × {preview.breakdown.charge_rate}/h ({preview.breakdown.rate_source})</div>
          <div style={{ fontSize: 18, fontWeight: 800, marginTop: 6 }}>{money(preview.breakdown.amount_cents, preview.breakdown.currency)}</div>
          {preview.invoice?.hosted_invoice_url && (
            <a href={preview.invoice.hosted_invoice_url} target="_blank" rel="noopener noreferrer" style={{ color: C.accent, fontSize: 13 }}>View Stripe invoice →</a>
          )}
        </div>
      ) : null}
    </div>
  );
}

function HistoryCard() {
  const [invoices, setInvoices] = useState([]);
  const [runs, setRuns] = useState([]);

  useEffect(() => {
    supabase.from('client_invoices').select('*').order('created_at', { ascending: false }).limit(20)
      .then(({ data }) => setInvoices(data || []));
    supabase.from('payment_runs').select('*').order('created_at', { ascending: false }).limit(20)
      .then(({ data }) => setRuns(data || []));
  }, []);

  return (
    <Card title="History">
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>Client invoices</div>
      {invoices.length === 0 ? <EmptyState message="No invoices yet." /> : (
        <TableWrap>
          <thead><tr><Th>Client</Th><Th>Period</Th><Th>Amount</Th><Th>Stripe status</Th><Th>Link</Th></tr></thead>
          <tbody>
            {invoices.map(iv => (
              <tr key={iv.id}>
                <Td>{iv.client}</Td><Td>{iv.period_from} → {iv.period_to}</Td>
                <Td>{money(iv.amount_cents, iv.currency)}</Td><Td>{iv.stripe_status || iv.status}</Td>
                <Td>{iv.hosted_invoice_url ? <a href={iv.hosted_invoice_url} target="_blank" rel="noopener noreferrer" style={{ color: C.accent }}>open</a> : '—'}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <div style={{ fontSize: 12, color: C.textMuted, margin: '14px 0 6px' }}>Payment runs</div>
      {runs.length === 0 ? <EmptyState message="No payment runs yet." /> : (
        <TableWrap>
          <thead><tr><Th>Period</Th><Th>Total</Th><Th>Status</Th><Th>Created</Th></tr></thead>
          <tbody>
            {runs.map(r => (
              <tr key={r.id}>
                <Td>{r.period_from} → {r.period_to}</Td><Td>{money(r.total_cents, r.currency)}</Td>
                <Td>{r.status}</Td><Td>{new Date(r.created_at).toLocaleDateString('en-AU')}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </Card>
  );
}
