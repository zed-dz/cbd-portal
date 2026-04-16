import { useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary, btnSecondary } from '../../theme';
import { todayISO } from '../../utils/dates';
import { downloadCSV } from '../../utils/csv';

export function ReportsPage({ showToast }) {
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
