import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnSecondary, btnSmall } from '../../theme';
import { fmtDate } from '../../utils/dates';
import { downloadCSV } from '../../utils/csv';
import { computePayrollRow, buildXeroCSV } from '../../utils/payroll';
import { Spinner, TableWrap, Th, Td, EmptyState } from '../../components';

export function PayrollTrackerPage({ showToast }) {
  const [timesheets, setTimesheets] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [clients, setClients] = useState([]);
  const [configMap, setConfigMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [filterType, setFilterType] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase.from('timesheets').select('*, workers(name)').eq('status', 'approved').order('date', { ascending: false });
    if (dateFrom) q = q.gte('date', dateFrom);
    if (dateTo) q = q.lte('date', dateTo);
    const [t, w, cl, cfg] = await Promise.all([
      q,
      supabase.from('workers').select('id, name, worker_type, pay_rate_regular, pay_rate_overtime, subcontractor_abn').order('name'),
      supabase.from('clients').select('id, name, rate_regular, rate_overtime, rate_night, rate_weekend').order('name'),
      supabase.from('payroll_config').select('config_key, config_value'),
    ]);
    if (t.error) showToast(t.error.message, 'error');
    else setTimesheets(t.data || []);
    if (w.data) setWorkers(w.data);
    if (cl.data) setClients(cl.data);
    if (cfg.data) {
      const map = {};
      cfg.data.forEach(r => { map[r.config_key] = r.config_value; });
      setConfigMap(map);
    }
    setLoading(false);
  }, [showToast, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  const payrollRows = timesheets.map(ts => {
    const worker = workers.find(w => w.id === ts.worker_id) || {};
    const client = clients.find(c => c.name === ts.client) || null;
    return computePayrollRow(ts, { ...worker, name: ts.workers?.name || worker.name }, client, configMap);
  });

  const filtered = filterType === 'all' ? payrollRows : payrollRows.filter(r => r.worker_type === filterType);

  const totals = filtered.reduce((acc, r) => ({
    pay_hours: acc.pay_hours + (parseFloat(r.pay_hours) || 0),
    total_pay: acc.total_pay + (parseFloat(r.total_pay) || 0),
    charge_amount: acc.charge_amount + (parseFloat(r.charge_amount) || 0),
  }), { pay_hours: 0, total_pay: 0, charge_amount: 0 });

  const handleXeroExport = () => {
    const staffRows = filtered.filter(r => r.worker_type !== 'subcontractor');
    if (!staffRows.length) { showToast('No staff timesheets to export.', 'info'); return; }
    buildXeroCSV(staffRows, dateFrom || 'all', dateTo || 'dates', downloadCSV);
    showToast('Xero CSV exported', 'success');
  };

  const handleSubExport = () => {
    const subRows = filtered.filter(r => r.worker_type === 'subcontractor');
    if (!subRows.length) { showToast('No subcontractor timesheets.', 'info'); return; }
    const rows = subRows.map(r => ({
      worker_name: r.worker_name, date: r.date, site: r.site, client: r.client,
      pay_hours: r.pay_hours, total_pay: r.total_pay, awj_reference: r.awj_reference,
      scenario: r.scenario,
    }));
    downloadCSV(`subcontractors_${dateFrom || 'all'}.csv`, rows);
    showToast('Subcontractor CSV exported', 'success');
  };

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
          <div>
            <label style={{ color: C.textMuted, fontSize: 13, display: 'block', marginBottom: 4 }}>Worker Type</label>
            <select style={{ ...inputStyle, width: 180 }} value={filterType} onChange={e => setFilterType(e.target.value)}>
              <option value="all">All Types</option>
              <option value="full-time">Full-Time</option>
              <option value="casual">Casual</option>
              <option value="subcontractor">Subcontractor</option>
            </select>
          </div>
          <button onClick={() => { setDateFrom(''); setDateTo(''); }} style={btnSecondary}>Clear</button>
          <div style={{ marginLeft: 'auto', background: C.card, borderRadius: 8, padding: '10px 20px', border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.warning }}>{totals.pay_hours.toFixed(1)}</div>
            <div style={{ color: C.textMuted, fontSize: 12 }}>Total Pay Hours</div>
          </div>
          <div style={{ background: C.card, borderRadius: 8, padding: '10px 20px', border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.success }}>${totals.total_pay.toFixed(2)}</div>
            <div style={{ color: C.textMuted, fontSize: 12 }}>Total Pay Amount</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <button onClick={handleXeroExport} style={{ ...btnSmall, color: '#93c5fd', borderColor: '#1e3a5f' }}>↓ Export Xero CSV (Staff)</button>
          <button onClick={handleSubExport} style={{ ...btnSmall, color: '#fde047', borderColor: '#713f12' }}>↓ Export Subcontractors CSV</button>
          <button onClick={() => showToast('Payroll run marked (Xero integration coming soon)', 'info')} style={{ ...btnSmall }}>✓ Mark as Payroll Run</button>
        </div>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div> : filtered.length === 0 ? (
        <EmptyState message="No approved timesheets in this range." />
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <Th>Worker</Th><Th>Type</Th><Th>Date</Th><Th>Scenario</Th>
              <Th>Pay Hrs</Th><Th>Charge Hrs</Th><Th>OT Hrs</Th>
              <Th>Allowances</Th><Th>Total Pay</Th><Th>Charge Amt</Th><Th>AWJ Ref</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={i}>
                <Td><strong>{r.worker_name}</strong></Td>
                <Td><span style={{ fontSize: 11, color: C.textMuted, fontFamily: '"DM Mono", monospace' }}>{r.worker_type}</span></Td>
                <Td>{fmtDate(r.date)}</Td>
                <Td><span style={{ fontSize: 11, color: C.textMuted }}>{r.scenario}</span></Td>
                <Td><span style={{ fontWeight: 700 }}>{r.pay_hours}</span></Td>
                <Td>{r.charge_hours}</Td>
                <Td>{r.overtime_hours > 0 ? <span style={{ color: C.warning }}>{r.overtime_hours}</span> : '—'}</Td>
                <Td>
                  <div style={{ fontSize: 11, color: C.textMuted }}>
                    {r.travel_allowance > 0 && <span>T: ${r.travel_allowance} </span>}
                    {r.meal_allowance > 0 && <span>M: ${r.meal_allowance}</span>}
                    {r.geo_loading && <span style={{ color: C.accent }}> GEO</span>}
                    {r.is_weekend && <span style={{ color: C.accent }}> WKD</span>}
                    {!r.travel_allowance && !r.meal_allowance && !r.geo_loading && !r.is_weekend && '—'}
                  </div>
                </Td>
                <Td><span style={{ fontWeight: 700, color: C.success }}>${r.total_pay}</span></Td>
                <Td><span style={{ color: C.warning }}>${r.charge_amount}</span></Td>
                <Td><span style={{ fontSize: 11, color: C.textMuted }}>{r.awj_reference || '—'}</span></Td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} style={{ padding: '10px 16px', color: C.textMuted, fontSize: 13, borderTop: `2px solid ${C.border}` }}>{filtered.length} records</td>
              <td style={{ padding: '10px 16px', fontWeight: 700, color: C.text, borderTop: `2px solid ${C.border}` }}>{totals.pay_hours.toFixed(2)}</td>
              <td colSpan={3} style={{ borderTop: `2px solid ${C.border}` }} />
              <td style={{ padding: '10px 16px', fontWeight: 700, color: C.success, borderTop: `2px solid ${C.border}` }}>${totals.total_pay.toFixed(2)}</td>
              <td style={{ padding: '10px 16px', fontWeight: 700, color: C.warning, borderTop: `2px solid ${C.border}` }}>${totals.charge_amount.toFixed(2)}</td>
              <td style={{ borderTop: `2px solid ${C.border}` }} />
            </tr>
          </tfoot>
        </TableWrap>
      )}
    </div>
  );
}
