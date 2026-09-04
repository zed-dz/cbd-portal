import { useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, inputStyle, btnPrimary } from '../../theme';
import { Spinner, TableWrap, Th, Td } from '../../components';

// The team asked for the config to read as "Regular Rates" plus clearly separated
// groups, instead of one flat list of code keys. The keys themselves are
// unchanged — this page only groups and labels them. Per-CLIENT rates do not
// live here at all: those are Clients & Rates → Schedule of Rates (one card per
// client) and Default Rates (the reusable master card).
const SECTIONS = [
  {
    title: 'Regular rates & overtime thresholds',
    hint: 'The standard award rules applied to every worker. A worker record can still override its own pay rates.',
    keys: {
      ot_threshold_daily:       'Ordinary hours per weekday before overtime (hrs)',
      ot_multiplier:            'Weekday overtime multiplier',
      saturday_threshold_hours: 'Saturday hours at 1.5× before 2× kicks in (hrs)',
      night_threshold_hours:    'Weekday-night hours at 1.5× before 2× (hrs)',
      rdo_daily_accrual:        'RDO banked per full-time weekday (hrs)',
      min_day_hours_fulltime:   'Full-time minimum paid day (hrs)',
      night_multiplier:         'Night multiplier (legacy — split rules apply instead)',
      weekend_multiplier:       'Weekend multiplier (legacy — split rules apply instead)',
    },
  },
  {
    title: 'Allowances & loadings',
    hint: 'Applied automatically from the timesheet — meal by shift length, travel per worked casual shift.',
    keys: {
      meal_allowance_trigger:      'Meal allowance after (hrs)',
      meal_allowance_amount:       'Meal allowance ($)',
      travel_allowance_casual:     'Casual travel allowance per worked shift ($)',
      subcontractor_night_loading: 'Subcontractor night/weekend flat loading ($)',
      geo_loading_pct:             'Geographic loading (0.10 = +10%)',
    },
  },
  {
    title: 'Fallback client charge rates',
    hint: 'Billed ONLY when a client has no rates of their own. Each client’s real prices belong on their Schedule of Rates.',
    keys: {
      default_client_rate_a: 'Rate A — normal time ($/hr)',
      default_client_rate_b: 'Rate B — overtime 1.5× ($/hr)',
      default_client_rate_c: 'Rate C — overtime 2× ($/hr)',
    },
  },
];

const KNOWN = new Set(SECTIONS.flatMap(s => Object.keys(s.keys)));

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

  const byKey = Object.fromEntries(configs.map(r => [r.config_key, r]));
  const unknownRows = configs.filter(r => !KNOWN.has(r.config_key));

  const renderRow = (row, label) => (
    <tr key={row.id}>
      <Td>
        <div style={{ fontSize: 13.5, color: C.text }}>{label || row.description || row.config_key}</div>
        <code style={{ fontFamily: '"DM Mono", monospace', fontSize: 10.5, color: C.textDim }}>{row.config_key}</code>
      </Td>
      <Td>
        <input
          style={{ ...inputStyle, maxWidth: 140 }}
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
  );

  return (
    <div>
      <div style={{ background: 'rgba(249,115,22,0.07)', border: '1px solid rgba(249,115,22,0.2)', borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: C.textMuted }}>
        ⚙ <strong style={{ color: C.text }}>Payroll Config</strong> — the portal-wide rules. Changes apply on the next payroll calculation.
        Looking for a <strong style={{ color: C.text }}>client&apos;s</strong> rates? Those live in <strong style={{ color: C.text }}>Clients &amp; Rates → Schedule of Rates</strong> (one per client), with the reusable master card under <strong style={{ color: C.text }}>Default Rates</strong>.
      </div>

      {SECTIONS.map(section => {
        const rows = Object.entries(section.keys)
          .map(([k, label]) => byKey[k] && { row: byKey[k], label })
          .filter(Boolean);
        if (!rows.length) return null;
        return (
          <div key={section.title} style={{ marginBottom: 26 }}>
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{section.title}</div>
              <div style={{ fontSize: 12.5, color: C.textMuted }}>{section.hint}</div>
            </div>
            <TableWrap>
              <thead><tr><Th>Setting</Th><Th>Value</Th><Th>Action</Th></tr></thead>
              <tbody>{rows.map(({ row, label }) => renderRow(row, label))}</tbody>
            </TableWrap>
          </div>
        );
      })}

      {unknownRows.length > 0 && (
        <div style={{ marginBottom: 26 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 8 }}>Other settings</div>
          <TableWrap>
            <thead><tr><Th>Setting</Th><Th>Value</Th><Th>Action</Th></tr></thead>
            <tbody>{unknownRows.map(row => renderRow(row, null))}</tbody>
          </TableWrap>
        </div>
      )}
    </div>
  );
}
