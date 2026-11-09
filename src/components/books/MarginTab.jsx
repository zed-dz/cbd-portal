import { useMemo, useState, useEffect } from 'react';
import { C, R, MONO, inputStyle } from '../../theme';
import { Badge, Spinner } from '../index';
import { Card, Stat, Seg, Num, Rows, CsvButton } from './BooksBits';
import { shiftMarginRows, groupMargin, marginTotals, marginLeaks, marginCSVRows } from '../../utils/booksMargin';
import { fmtMoney } from '../../utils/books';
import { saveSnapshot } from './useBooksData';

// Gross margin = billed (charge rates) − pay (payroll maths), per client /
// site / worker / week, from approved timesheets in the chosen range.

const DIMS = [['client', 'Client'], ['site', 'Site'], ['worker', 'Worker'], ['week', 'Week']];
const LEAK_LABEL = { client_under_floor: 'Under floor', worker_cost_over_charge: 'Costs more than billed', paid_not_billed: 'Paid, not billed', rate_missing: 'Rate missing' };
const LEAK_COLOR = { client_under_floor: 'yellow', worker_cost_over_charge: 'red', paid_not_billed: 'orange', rate_missing: 'red' };

export function MarginTab({ data, narrow, who }) {
  const { timesheets, workers, clients, rateCards, roleRates, config, settings, marginRange, setMarginRange, tsLoading } = data;
  const [dim, setDim] = useState('client');
  const floor = Number(settings?.margin_floor_pct) || 15;

  const rows = useMemo(() => shiftMarginRows({ timesheets, workers, clients, rateCards, roleRates, config }), [timesheets, workers, clients, rateCards, roleRates, config]);
  const groups = useMemo(() => groupMargin(rows, dim), [rows, dim]);
  const totals = useMemo(() => marginTotals(rows), [rows]);
  const leaks = useMemo(() => marginLeaks(rows, floor), [rows, floor]);

  useEffect(() => {
    if (!rows.length) return;
    saveSnapshot('margin', {
      period: marginRange, totals, leaks,
      client: groupMargin(rows, 'client'), site: groupMargin(rows, 'site'), worker: groupMargin(rows, 'worker'), week: groupMargin(rows, 'week'),
    }, who);
  }, [rows, totals, leaks, marginRange, who]);

  const cols = [
    { key: 'label', label: DIMS.find((x) => x[0] === dim)[1], render: (g) => <span style={{ fontWeight: 600 }}>{g.label}{g.rate_missing ? <span style={{ marginLeft: 6 }}><Badge label="rate missing" color="red" size="sm" /></span> : null}</span> },
    { key: 'shifts', label: 'Shifts', align: 'right', render: (g) => <span style={{ fontFamily: MONO }}>{g.shifts}</span> },
    { key: 'hours', label: 'Hours', align: 'right', render: (g) => <span style={{ fontFamily: MONO }}>{g.hours.toFixed(2)}</span> },
    { key: 'charge', label: 'Billed', align: 'right', render: (g) => <Num v={g.charge} /> },
    { key: 'pay', label: 'Pay', align: 'right', render: (g) => <Num v={g.pay} /> },
    { key: 'margin', label: 'Margin', align: 'right', render: (g) => <Num v={g.margin} signed bold /> },
    { key: 'margin_pct', label: '%', align: 'right', render: (g) => <Num v={g.margin_pct} pct color={g.charge > 0 && g.margin_pct < floor ? '#fde047' : undefined} /> },
  ];

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="date" value={marginRange.from} onChange={(e) => setMarginRange((r) => ({ ...r, from: e.target.value }))} style={{ ...inputStyle, width: narrow ? 'calc(50% - 4px)' : 150, minHeight: 40 }} aria-label="From" />
        <input type="date" value={marginRange.to} onChange={(e) => setMarginRange((r) => ({ ...r, to: e.target.value }))} style={{ ...inputStyle, width: narrow ? 'calc(50% - 4px)' : 150, minHeight: 40 }} aria-label="To" />
        <Seg options={DIMS} value={dim} onChange={setDim} />
        <span style={{ marginLeft: 'auto' }}><CsvButton rows={marginCSVRows(groups, dim)} filename={`margin-${dim}-${marginRange.from}-${marginRange.to}.csv`} /></span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: narrow ? 'repeat(2, minmax(0, 1fr))' : 'repeat(5, minmax(0, 1fr))', gap: 8 }}>
        <Stat label="Billed" value={fmtMoney(totals.charge)} tone="in" />
        <Stat label="Pay" value={fmtMoney(totals.pay)} tone="out" />
        <Stat label="Gross margin" value={fmtMoney(totals.margin)} tone={totals.margin < 0 ? 'out' : undefined} />
        <Stat label="Margin %" value={`${totals.margin_pct.toFixed(1)}%`} hint={`floor ${floor}%`} />
        <Stat label="Shifts · hours" value={`${totals.shifts} · ${totals.hours.toFixed(1)}h`} />
      </div>

      {tsLoading ? <div style={{ padding: 20, textAlign: 'center' }}><Spinner /></div> : (
        <Card title={`Margin by ${DIMS.find((x) => x[0] === dim)[1].toLowerCase()}`}>
          <Rows cols={cols} rows={groups} narrow={narrow} keyOf={(g) => g.key} empty="No approved timesheets in this range." />
        </Card>
      )}

      <Card title="Margin leaks" right={<span style={{ fontFamily: MONO, fontSize: 11, color: C.textMuted }}>{leaks.length}</span>}>
        {leaks.length === 0 ? <div style={{ color: '#86efac', fontSize: 13 }}>None in this range.</div> : (
          <div style={{ display: 'grid', gap: 6 }}>
            {leaks.map((l, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'auto 1fr auto', gap: 8, alignItems: 'center', background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.md, padding: '8px 10px' }}>
                <Badge label={LEAK_LABEL[l.kind] || l.kind} color={LEAK_COLOR[l.kind] || 'gray'} size="sm" />
                <span style={{ fontSize: 13, color: C.text, minWidth: 0, overflowWrap: 'anywhere' }}><b>{l.who}</b> <span style={{ color: C.textMuted }}>· {l.detail}</span></span>
                <Num v={l.margin} signed bold />
              </div>
            ))}
          </div>
        )}
      </Card>
      <div style={{ fontSize: 11, color: C.textDim }}>Same charge and pay maths as Payroll. Range: {marginRange.from} → {marginRange.to}.</div>
    </div>
  );
}
