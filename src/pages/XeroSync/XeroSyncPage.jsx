import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, btnSmall, btnSecondary, btnPrimary } from '../../theme';
import { Spinner, TableWrap, Th, Td, EmptyState } from '../../components';

const EDGE = 'https://tsizneslellcqusjwtub.supabase.co/functions/v1/xero-data';

const TABS = [
  { id: 'employees',  label: 'Employees',    key: 'employees' },
  { id: 'payruns',    label: 'Pay History',  key: 'payRuns' },
  { id: 'contacts',   label: 'Contacts',     key: 'contacts' },
  { id: 'leave',      label: 'Leave',        key: 'leaveApplications' },
  { id: 'setup',      label: 'Pay Setup',    key: null },
];

function fmt(dateStr) {
  if (!dateStr) return '—';
  // Xero returns dates like /Date(1234567890000+0000)/
  const match = dateStr.match(/\/Date\((\d+)/);
  if (match) return new Date(parseInt(match[1])).toLocaleDateString('en-AU');
  return dateStr.slice(0, 10);
}

function money(val) {
  if (val == null || val === '') return '—';
  return `$${parseFloat(val).toFixed(2)}`;
}

function statusBadge(status) {
  const colors = {
    ACTIVE: { bg: 'rgba(34,197,94,0.15)', color: '#22c55e' },
    TERMINATED: { bg: 'rgba(239,68,68,0.12)', color: '#ef4444' },
    POSTED: { bg: 'rgba(34,197,94,0.15)', color: '#22c55e' },
    DRAFT: { bg: 'rgba(249,115,22,0.15)', color: '#f97316' },
    PAID: { bg: 'rgba(19,181,234,0.15)', color: '#13B5EA' },
    APPROVED: { bg: 'rgba(34,197,94,0.15)', color: '#22c55e' },
    REJECTED: { bg: 'rgba(239,68,68,0.12)', color: '#ef4444' },
  };
  const s = status?.toUpperCase() || '';
  const c = colors[s] || { bg: 'rgba(100,100,100,0.12)', color: '#888' };
  return (
    <span style={{ background: c.bg, color: c.color, borderRadius: 5, padding: '2px 8px', fontSize: 11, fontWeight: 600, fontFamily: '"DM Mono", monospace' }}>
      {status || '—'}
    </span>
  );
}

export function XeroSyncPage({ showToast }) {
  const [tab, setTab] = useState('employees');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedRun, setExpandedRun] = useState(null);
  const [payslips, setPayslips] = useState({});
  const [loadingSlips, setLoadingSlips] = useState(null);
  const [expandedEmp, setExpandedEmp] = useState(null);
  const [syncingRates, setSyncingRates] = useState(false);

  const callEdge = useCallback(async (params = '') => {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`${EDGE}${params}`, {
      headers: { 'Authorization': `Bearer ${session?.access_token}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Xero fetch failed');
    }
    return res.json();
  }, []);

  const sync = useCallback(async () => {
    setLoading(true);
    try {
      const result = await callEdge('?entity=all');
      setData(result);
    } catch (e) {
      showToast(e.message, 'error');
    }
    setLoading(false);
  }, [callEdge, showToast]);

  useEffect(() => { sync(); }, [sync]);

  const loadPayslips = async (payRunId) => {
    if (payslips[payRunId]) { setExpandedRun(expandedRun === payRunId ? null : payRunId); return; }
    setLoadingSlips(payRunId);
    try {
      const result = await callEdge(`?entity=payslips&payRunId=${payRunId}`);
      setPayslips(prev => ({ ...prev, [payRunId]: result.paySlips || [] }));
      setExpandedRun(payRunId);
    } catch (e) {
      showToast('Could not load payslips: ' + e.message, 'error');
    }
    setLoadingSlips(null);
  };

  const syncPayRates = useCallback(async () => {
    if (!data?.employees?.length) return;
    setSyncingRates(true);
    try {
      // Build a name → rate map from Xero employees
      const xeroRates = {};
      for (const e of data.employees) {
        const fullName = `${e.FirstName} ${e.LastName}`.trim().toLowerCase();
        const line = (e.PayTemplate?.EarningsLines || []).find(l => l.RatePerUnit != null);
        if (line?.RatePerUnit) xeroRates[fullName] = parseFloat(line.RatePerUnit);
      }
      if (Object.keys(xeroRates).length === 0) {
        showToast('No pay rates found in Xero Pay Templates.', 'error');
        setSyncingRates(false);
        return;
      }

      // Fetch portal workers
      const { data: workers, error } = await supabase.from('workers').select('id, name');
      if (error) throw error;

      let updated = 0;
      const unmatched = [];
      for (const w of workers) {
        const key = (w.name || '').trim().toLowerCase();
        if (xeroRates[key] != null) {
          await supabase.from('workers').update({ pay_rate_regular: xeroRates[key] }).eq('id', w.id);
          updated++;
        } else {
          unmatched.push(w.name);
        }
      }

      const msg = `Updated ${updated} worker${updated !== 1 ? 's' : ''}.${unmatched.length ? ` No Xero match for: ${unmatched.join(', ')}.` : ''}`;
      showToast(msg, updated > 0 ? 'success' : 'error');
    } catch (e) {
      showToast('Sync failed: ' + e.message, 'error');
    }
    setSyncingRates(false);
  }, [data, showToast]);

  const tabCount = (key) => {
    if (!data || !key) return null;
    const n = data[key]?.length;
    return n > 0 ? n : null;
  };

  if (loading) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 16 }}>
      <Spinner size={36} />
      <div style={{ color: C.textMuted, fontSize: 13 }}>Fetching data from Xero…</div>
    </div>
  );

  if (!data) return <EmptyState message="Could not load Xero data. Make sure Xero is connected from the Payroll page." />;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, color: C.textMuted, fontFamily: '"DM Mono", monospace', marginBottom: 2 }}>
            Synced {data.syncedAt ? new Date(data.syncedAt).toLocaleString('en-AU') : '—'}
          </div>
          {!data.hasAccountingScope && (
            <div style={{ fontSize: 11, color: C.warning }}>
              Contacts tab requires <code>accounting.contacts.read</code> scope — reconnect Xero from the Payroll page to enable it.
            </div>
          )}
        </div>
        <button onClick={sync} disabled={loading} style={{ ...btnSecondary, marginLeft: 'auto' }}>
          {loading ? 'Syncing…' : '↻ Sync Now'}
        </button>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 20 }}>
        {[
          { label: 'Employees', value: data.employees?.length || 0, color: C.accent },
          { label: 'Pay Runs', value: data.payRuns?.length || 0, color: C.success },
          { label: 'Contacts', value: data.contacts?.length || 0, color: '#13B5EA' },
          { label: 'Leave Records', value: data.leaveApplications?.length || 0, color: C.warning },
          { label: 'Earnings Rates', value: data.earningsRates?.length || 0, color: C.textMuted },
          { label: 'Payroll Calendars', value: data.payrollCalendars?.length || 0, color: C.textMuted },
        ].map(c => (
          <div key={c.label} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 9, padding: '12px 14px' }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: c.color }}>{c.value}</div>
            <div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1, fontFamily: '"DM Mono", monospace', marginTop: 3 }}>{c.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, borderBottom: `1px solid ${C.border}`, marginBottom: 20 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: 'none', border: 'none', borderBottom: tab === t.id ? `2px solid ${C.accent}` : '2px solid transparent',
            color: tab === t.id ? C.text : C.textMuted, padding: '8px 14px', cursor: 'pointer',
            fontSize: 13, fontWeight: tab === t.id ? 600 : 400, marginBottom: -1,
            display: 'flex', alignItems: 'center', gap: 5,
          }}>
            {t.label}
            {tabCount(t.key) && (
              <span style={{ background: C.border, borderRadius: 10, fontSize: 10, padding: '1px 5px', fontFamily: '"DM Mono", monospace' }}>
                {tabCount(t.key)}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── EMPLOYEES ─────────────────────────────────────────────────────── */}
      {tab === 'employees' && (
        data.employees.length === 0
          ? <EmptyState message="No employees found in Xero Payroll." />
          : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                <div style={{ fontSize: 12, color: C.textMuted }}>
                  Click any row to expand full employee details.
                </div>
                <button
                  onClick={syncPayRates}
                  disabled={syncingRates}
                  style={{ ...btnPrimary, padding: '7px 14px', fontSize: 12, fontWeight: 600 }}
                  title="Reads the hourly rate from each employee's Xero Pay Template and updates the matching portal worker's pay rate"
                >
                  {syncingRates ? 'Syncing…' : '💸 Sync Pay Rates → Workers'}
                </button>
              </div>
            <TableWrap>
              <thead>
                <tr>
                  <Th>Name</Th><Th>Email</Th><Th>DOB</Th><Th>Start Date</Th>
                  <Th>Employment</Th><Th>Pay Method</Th><Th>Status</Th><Th>Details</Th>
                </tr>
              </thead>
              <tbody>
                {data.employees.map(e => (
                  <>
                    <tr key={e.EmployeeID} style={{ cursor: 'pointer' }} onClick={() => setExpandedEmp(expandedEmp === e.EmployeeID ? null : e.EmployeeID)}>
                      <Td><strong>{e.FirstName} {e.LastName}</strong></Td>
                      <Td><span style={{ fontSize: 12, color: C.textMuted }}>{e.Email || '—'}</span></Td>
                      <Td><span style={{ fontFamily: '"DM Mono", monospace', fontSize: 11 }}>{fmt(e.DateOfBirth)}</span></Td>
                      <Td><span style={{ fontFamily: '"DM Mono", monospace', fontSize: 11 }}>{fmt(e.StartDate)}</span></Td>
                      <Td><span style={{ fontSize: 11, color: C.textMuted }}>{e.EmploymentBasis || '—'}</span></Td>
                      <Td><span style={{ fontSize: 11, color: C.textMuted }}>{e.PaymentMethod || '—'}</span></Td>
                      <Td>{statusBadge(e.Status)}</Td>
                      <Td>
                        <button style={{ ...btnSmall, fontSize: 10 }}>{expandedEmp === e.EmployeeID ? '▲ Hide' : '▼ More'}</button>
                      </Td>
                    </tr>
                    {expandedEmp === e.EmployeeID && (
                      <tr key={`${e.EmployeeID}-detail`}>
                        <td colSpan={8} style={{ padding: 0 }}>
                          <div style={{ background: C.bg, borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, padding: '14px 20px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
                            <Section label="Personal">
                              <Row label="Gender" val={e.Gender} />
                              <Row label="Phone" val={e.Mobile || e.Phone} />
                              <Row label="Address" val={[e.HomeAddress?.AddressLine1, e.HomeAddress?.City, e.HomeAddress?.PostalCode].filter(Boolean).join(', ')} />
                            </Section>
                            <Section label="Tax">
                              <Row label="TFN" val={e.TaxDeclaration?.TaxFileNumber ? '••••••' + String(e.TaxDeclaration.TaxFileNumber).slice(-3) : '—'} />
                              <Row label="Basis" val={e.TaxDeclaration?.EmploymentBasis} />
                              <Row label="Resident" val={e.TaxDeclaration?.AustralianResidentForTaxPurposes ? 'Yes' : 'No'} />
                              <Row label="Tax-free threshold" val={e.TaxDeclaration?.TaxFreeThresholdClaimed ? 'Claimed' : 'Not claimed'} />
                            </Section>
                            <Section label="Bank Account">
                              {(e.BankAccounts || []).length === 0
                                ? <span style={{ fontSize: 12, color: C.textMuted }}>None on file</span>
                                : (e.BankAccounts || []).map((b, i) => (
                                  <div key={i} style={{ marginBottom: 4 }}>
                                    <Row label="BSB" val={b.BSB} />
                                    <Row label="Account" val={b.AccountNumber ? '••••' + String(b.AccountNumber).slice(-3) : '—'} />
                                    <Row label="Name" val={b.AccountName} />
                                  </div>
                                ))}
                            </Section>
                            <Section label="Superannuation">
                              {(e.SuperMemberships || []).length === 0
                                ? <span style={{ fontSize: 12, color: C.textMuted }}>None on file</span>
                                : (e.SuperMemberships || []).map((s, i) => (
                                  <div key={i} style={{ marginBottom: 4 }}>
                                    <Row label="Fund" val={s.SuperFundID} />
                                    <Row label="Member No." val={s.EmployeeNumber} />
                                  </div>
                                ))}
                            </Section>
                            <Section label="Pay Template">
                              {(e.PayTemplate?.EarningsLines || []).map((l, i) => (
                                <Row key={i} label={l.EarningsType || 'Earnings'} val={l.RatePerUnit ? `$${l.RatePerUnit}/hr` : l.AnnualSalary ? `$${l.AnnualSalary}/yr` : '—'} />
                              ))}
                            </Section>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </TableWrap>
            </>
          )
      )}

      {/* ── PAY HISTORY ───────────────────────────────────────────────────── */}
      {tab === 'payruns' && (
        data.payRuns.length === 0
          ? <EmptyState message="No pay runs found in Xero. Pay runs appear here once created and posted." />
          : (
            <div>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>
                Click any row to expand payslips for that run.
              </div>
              {[...data.payRuns].sort((a, b) => (b.PaymentDate || '').localeCompare(a.PaymentDate || '')).map(run => (
                <div key={run.PayRunID} style={{ marginBottom: 8 }}>
                  <div
                    onClick={() => loadPayslips(run.PayRunID)}
                    style={{
                      background: C.card, border: `1px solid ${expandedRun === run.PayRunID ? C.accent : C.border}`,
                      borderRadius: expandedRun === run.PayRunID ? '10px 10px 0 0' : 10,
                      padding: '12px 16px', cursor: 'pointer',
                      display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr auto', gap: 12, alignItems: 'center',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2 }}>Pay Period</div>
                      <div style={{ fontSize: 12, fontFamily: '"DM Mono", monospace' }}>
                        {fmt(run.PayPeriodStartDate)} → {fmt(run.PayPeriodEndDate)}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2 }}>Payment Date</div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{fmt(run.PaymentDate)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2 }}>Total Pay</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.success }}>{money(run.Wages)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2 }}>Employer Cost</div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.warning }}>{money(run.SuperannuationAmount ? (parseFloat(run.Wages || 0) + parseFloat(run.SuperannuationAmount || 0)).toFixed(2) : null)}</div>
                    </div>
                    <div>{statusBadge(run.PayRunStatus)}</div>
                    <div style={{ fontSize: 11, color: C.textMuted }}>
                      {loadingSlips === run.PayRunID ? <Spinner size={14} /> : expandedRun === run.PayRunID ? '▲' : '▼ Payslips'}
                    </div>
                  </div>

                  {expandedRun === run.PayRunID && payslips[run.PayRunID] && (
                    <div style={{ border: `1px solid ${C.accent}`, borderTop: 'none', borderRadius: '0 0 10px 10px', overflow: 'hidden' }}>
                      <TableWrap>
                        <thead>
                          <tr>
                            <Th>Employee</Th><Th>Gross Earnings</Th><Th>Tax</Th>
                            <Th>Net Pay</Th><Th>Super</Th><Th>Allowances</Th><Th>Deductions</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {payslips[run.PayRunID].map(slip => (
                            <tr key={slip.EmployeeID}>
                              <Td><strong>{slip.FirstName} {slip.LastName}</strong></Td>
                              <Td><span style={{ color: C.success, fontWeight: 600 }}>{money(slip.GrossEarnings)}</span></Td>
                              <Td><span style={{ color: C.error }}>{money(slip.TotalTax)}</span></Td>
                              <Td><span style={{ fontWeight: 700, color: C.text }}>{money(slip.NetPay)}</span></Td>
                              <Td>{money(slip.SuperannuationAmount)}</Td>
                              <Td>
                                {(slip.AllowanceLines || []).length > 0
                                  ? (slip.AllowanceLines || []).map((a, i) => (
                                    <div key={i} style={{ fontSize: 11, color: C.textMuted }}>{a.Description}: {money(a.Amount)}</div>
                                  ))
                                  : '—'}
                              </Td>
                              <Td>
                                {(slip.DeductionLines || []).length > 0
                                  ? (slip.DeductionLines || []).map((d, i) => (
                                    <div key={i} style={{ fontSize: 11, color: C.textMuted }}>{d.Description}: {money(d.Amount)}</div>
                                  ))
                                  : '—'}
                              </Td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr>
                            <td style={{ padding: '8px 16px', fontSize: 12, color: C.textMuted, borderTop: `1px solid ${C.border}` }}>
                              {payslips[run.PayRunID].length} employees
                            </td>
                            <td style={{ padding: '8px 16px', fontWeight: 700, color: C.success, borderTop: `1px solid ${C.border}` }}>
                              {money(payslips[run.PayRunID].reduce((s, x) => s + (parseFloat(x.GrossEarnings) || 0), 0).toFixed(2))}
                            </td>
                            <td style={{ padding: '8px 16px', fontWeight: 700, color: C.error, borderTop: `1px solid ${C.border}` }}>
                              {money(payslips[run.PayRunID].reduce((s, x) => s + (parseFloat(x.TotalTax) || 0), 0).toFixed(2))}
                            </td>
                            <td style={{ padding: '8px 16px', fontWeight: 700, borderTop: `1px solid ${C.border}` }}>
                              {money(payslips[run.PayRunID].reduce((s, x) => s + (parseFloat(x.NetPay) || 0), 0).toFixed(2))}
                            </td>
                            <td style={{ padding: '8px 16px', borderTop: `1px solid ${C.border}` }}>
                              {money(payslips[run.PayRunID].reduce((s, x) => s + (parseFloat(x.SuperannuationAmount) || 0), 0).toFixed(2))}
                            </td>
                            <td colSpan={2} style={{ borderTop: `1px solid ${C.border}` }} />
                          </tr>
                        </tfoot>
                      </TableWrap>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
      )}

      {/* ── CONTACTS ──────────────────────────────────────────────────────── */}
      {tab === 'contacts' && (
        !data.hasAccountingScope
          ? (
            <div style={{ background: 'rgba(249,115,22,0.07)', border: '1px solid rgba(249,115,22,0.2)', borderRadius: 10, padding: '20px 24px' }}>
              <div style={{ fontWeight: 700, color: C.text, marginBottom: 8 }}>Accounting scope not connected</div>
              <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 12 }}>
                To see your Xero contacts (clients, suppliers), go to <strong>Payroll</strong> and click <strong>Reconnect</strong> to grant the <code>accounting.contacts.read</code> scope.
              </div>
            </div>
          )
          : data.contacts.length === 0
            ? <EmptyState message="No contacts found in Xero." />
            : (
              <TableWrap>
                <thead>
                  <tr><Th>Name</Th><Th>Email</Th><Th>Phone</Th><Th>Type</Th><Th>Account No.</Th><Th>Status</Th></tr>
                </thead>
                <tbody>
                  {data.contacts.map(c => (
                    <tr key={c.ContactID}>
                      <Td><strong>{c.Name}</strong></Td>
                      <Td><span style={{ fontSize: 12, color: C.textMuted }}>{c.EmailAddress || '—'}</span></Td>
                      <Td><span style={{ fontSize: 12, color: C.textMuted }}>{c.Phones?.find(p => p.PhoneType === 'DEFAULT')?.PhoneNumber || '—'}</span></Td>
                      <Td>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {c.IsCustomer && <span style={{ background: 'rgba(19,181,234,0.15)', color: '#13B5EA', borderRadius: 5, padding: '2px 6px', fontSize: 10, fontWeight: 600 }}>Customer</span>}
                          {c.IsSupplier && <span style={{ background: 'rgba(168,85,247,0.15)', color: '#a855f7', borderRadius: 5, padding: '2px 6px', fontSize: 10, fontWeight: 600 }}>Supplier</span>}
                        </div>
                      </Td>
                      <Td><span style={{ fontFamily: '"DM Mono", monospace', fontSize: 11 }}>{c.AccountNumber || '—'}</span></Td>
                      <Td>{statusBadge(c.ContactStatus)}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )
      )}

      {/* ── LEAVE ─────────────────────────────────────────────────────────── */}
      {tab === 'leave' && (
        data.leaveApplications.length === 0
          ? <EmptyState message="No leave applications found in Xero." />
          : (
            <TableWrap>
              <thead>
                <tr><Th>Employee</Th><Th>Leave Type</Th><Th>From</Th><Th>To</Th><Th>Hours</Th><Th>Status</Th><Th>Description</Th></tr>
              </thead>
              <tbody>
                {[...data.leaveApplications]
                  .sort((a, b) => (b.StartDate || '').localeCompare(a.StartDate || ''))
                  .map(la => (
                    <tr key={la.LeaveApplicationID}>
                      <Td><strong>{la.FirstName} {la.LastName}</strong></Td>
                      <Td><span style={{ fontSize: 12, color: C.textMuted }}>{la.LeaveTypeID || '—'}</span></Td>
                      <Td><span style={{ fontFamily: '"DM Mono", monospace', fontSize: 11 }}>{fmt(la.StartDate)}</span></Td>
                      <Td><span style={{ fontFamily: '"DM Mono", monospace', fontSize: 11 }}>{fmt(la.EndDate)}</span></Td>
                      <Td><span style={{ fontWeight: 600 }}>{la.LeavePeriods?.reduce((s, p) => s + (p.NumberOfUnits || 0), 0).toFixed(1) || '—'}</span></Td>
                      <Td>{statusBadge(la.LeaveApplicationStatus || la.Status)}</Td>
                      <Td><span style={{ fontSize: 11, color: C.textMuted }}>{la.Description || '—'}</span></Td>
                    </tr>
                  ))}
              </tbody>
            </TableWrap>
          )
      )}

      {/* ── PAY SETUP ─────────────────────────────────────────────────────── */}
      {tab === 'setup' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18 }}>
            <div style={{ fontWeight: 700, color: C.text, marginBottom: 12, fontSize: 14 }}>Payroll Calendars</div>
            {data.payrollCalendars.length === 0
              ? <span style={{ fontSize: 12, color: C.textMuted }}>None found.</span>
              : data.payrollCalendars.map(cal => (
                <div key={cal.PayrollCalendarID} style={{ background: C.bg, borderRadius: 7, padding: '10px 12px', marginBottom: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{cal.Name}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>
                    {cal.CalendarType} · Payment date: {fmt(cal.PaymentDate)} · Period start: {fmt(cal.StartDate)}
                  </div>
                </div>
              ))}
          </div>

          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18 }}>
            <div style={{ fontWeight: 700, color: C.text, marginBottom: 12, fontSize: 14 }}>Earnings Rates</div>
            {data.earningsRates.length === 0
              ? <span style={{ fontSize: 12, color: C.textMuted }}>None found.</span>
              : data.earningsRates.map(r => (
                <div key={r.EarningsRateID} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${C.border}` }}>
                  <span style={{ fontSize: 12, color: C.text }}>{r.Name}</span>
                  <span style={{ fontSize: 11, color: C.textMuted, fontFamily: '"DM Mono", monospace' }}>{r.EarningsType}</span>
                </div>
              ))}
          </div>

          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18 }}>
            <div style={{ fontWeight: 700, color: C.text, marginBottom: 12, fontSize: 14 }}>Leave Types</div>
            {data.leaveTypes.length === 0
              ? <span style={{ fontSize: 12, color: C.textMuted }}>None found.</span>
              : data.leaveTypes.map(l => (
                <div key={l.LeaveTypeID} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${C.border}` }}>
                  <span style={{ fontSize: 12, color: C.text }}>{l.Name}</span>
                  <span style={{ fontSize: 11, color: C.textMuted }}>{l.IsPaidLeave ? 'Paid' : 'Unpaid'}</span>
                </div>
              ))}
          </div>

          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18 }}>
            <div style={{ fontWeight: 700, color: C.text, marginBottom: 12, fontSize: 14 }}>Deduction & Reimbursement Types</div>
            {(data.deductionTypes.length + data.reimbursementTypes.length) === 0
              ? <span style={{ fontSize: 12, color: C.textMuted }}>None found.</span>
              : (
                <>
                  {data.deductionTypes.map(d => (
                    <div key={d.DeductionTypeID} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${C.border}` }}>
                      <span style={{ fontSize: 12, color: C.text }}>{d.Name}</span>
                      <span style={{ fontSize: 10, color: C.error, fontFamily: '"DM Mono", monospace' }}>DEDUCTION</span>
                    </div>
                  ))}
                  {data.reimbursementTypes.map(r => (
                    <div key={r.ReimbursementTypeID} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${C.border}` }}>
                      <span style={{ fontSize: 12, color: C.text }}>{r.Name}</span>
                      <span style={{ fontSize: 10, color: C.success, fontFamily: '"DM Mono", monospace' }}>REIMBURSEMENT</span>
                    </div>
                  ))}
                </>
              )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function Section({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1.5, color: C.textMuted, fontFamily: '"DM Mono", monospace', marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

function Row({ label, val }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 3 }}>
      <span style={{ fontSize: 11, color: C.textMuted }}>{label}</span>
      <span style={{ fontSize: 11, color: C.text, textAlign: 'right', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{val || '—'}</span>
    </div>
  );
}
