import { useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary } from '../../theme';
import { Spinner, TableWrap, Th, Td } from '../../components';

export function PayrollConfigPage({ showToast }) {
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState({});
  const [edits, setEdits] = useState({});

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from('payroll_config').select('*').order('config_key');
      if (error) showToast(error.message, 'error');
      else {
        setConfigs(data || []);
        const initial = {};
        (data || []).forEach(r => { initial[r.id] = r.config_value; });
        setEdits(initial);
      }
      setLoading(false);
    })();
  }, [showToast]);

  const handleSave = async (row) => {
    setSaving(s => ({ ...s, [row.id]: true }));
    const { error } = await supabase.from('payroll_config')
      .update({ config_value: edits[row.id], updated_at: new Date().toISOString() })
      .eq('id', row.id);
    if (error) showToast(error.message, 'error');
    else showToast(`${row.config_key} updated`, 'success');
    setSaving(s => ({ ...s, [row.id]: false }));
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;

  return (
    <div>
      <div style={{ background: 'rgba(249,115,22,0.07)', border: '1px solid rgba(249,115,22,0.2)', borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: C.textMuted }}>
        ⚙ <strong style={{ color: C.text }}>Payroll Config</strong> — adjust award rates, multipliers and allowance thresholds without a code deploy. Changes take effect on next payroll calculation.
      </div>
      <TableWrap>
        <thead>
          <tr><Th>Config Key</Th><Th>Description</Th><Th>Value</Th><Th>Action</Th></tr>
        </thead>
        <tbody>
          {configs.map(row => (
            <tr key={row.id}>
              <Td><code style={{ fontFamily: '"DM Mono", monospace', fontSize: 12, color: C.accent }}>{row.config_key}</code></Td>
              <Td><span style={{ fontSize: 13, color: C.textMuted }}>{row.description || '—'}</span></Td>
              <Td>
                <input
                  style={{ ...inputStyle, maxWidth: 160 }}
                  value={edits[row.id] ?? row.config_value}
                  onChange={e => setEdits(ed => ({ ...ed, [row.id]: e.target.value }))}
                />
              </Td>
              <Td>
                <button
                  onClick={() => handleSave(row)}
                  disabled={saving[row.id] || edits[row.id] === row.config_value}
                  style={{ ...btnPrimary, padding: '6px 14px', fontSize: 12 }}
                >
                  {saving[row.id] ? 'Saving…' : 'Save'}
                </button>
              </Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </div>
  );
}
