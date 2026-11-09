import { useState, useEffect } from 'react';
import { C, R, MONO, inputStyle, btnSmall } from '../../theme';
import { fmtMoney, monthLabel, AGEING_BUCKETS } from '../../utils/books';
import { TableWrap, Th, Td, Badge } from '../index';
import { downloadCSV } from '../../utils/csv';

// Small building blocks for the Books page. All inline styles, theme tokens
// only, phone-first: every block is a card that stacks at 360 px.

export function Card({ title, right, children, style }) {
  return (
    <section style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: R.lg, padding: 16, minWidth: 0, ...style }}>
      {(title || right) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          {title && <h3 style={{ margin: 0, fontSize: 13, color: C.textMuted, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase', fontFamily: MONO }}>{title}</h3>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

// One figure with its label; the BAS row is six of these.
export function Stat({ label, value, hint, tone }) {
  const color = tone === 'in' ? '#86efac' : tone === 'out' ? '#fca5a5' : C.text;
  return (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.md, padding: '10px 12px', minWidth: 0 }}>
      <div style={{ fontSize: 10, color: C.textMuted, fontFamily: MONO, letterSpacing: 1, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color, fontFamily: MONO, marginTop: 4, overflowWrap: 'anywhere' }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: C.textDim, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

// Cash in / out by month as a CSS bar list — no chart library.
export function CashBars({ months }) {
  const rows = months || [];
  const max = Math.max(1, ...rows.map((m) => Math.max(Number(m.cash_in) || 0, Number(m.cash_out) || 0)));
  if (!rows.length) return <div style={{ color: C.textDim, fontSize: 13 }}>No cash movements yet.</div>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {rows.map((m) => {
        const inW = Math.round(((Number(m.cash_in) || 0) / max) * 100);
        const outW = Math.round(((Number(m.cash_out) || 0) / max) * 100);
        const key = typeof m.month === 'string' ? m.month.slice(0, 7) : String(m.month);
        return (
          <div key={key} style={{ display: 'grid', gridTemplateColumns: '52px 1fr', gap: 10, alignItems: 'center' }}>
            <div style={{ fontSize: 12, color: C.textMuted, fontFamily: MONO }}>{monthLabel(key)}</div>
            <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
              <Bar width={inW} color="#22c55e" label={`In ${fmtMoney(m.cash_in)}`} />
              <Bar width={outW} color="#ef4444" label={`Out ${fmtMoney(m.cash_out)}`} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Bar({ width, color, label }) {
  return (
    <div style={{ position: 'relative', height: 18, background: C.bg, borderRadius: R.sm, overflow: 'hidden' }} title={label}>
      <div style={{ position: 'absolute', inset: 0, width: `${Math.max(width, 1)}%`, background: color, opacity: 0.35, borderRadius: R.sm }} />
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', padding: '0 6px', fontSize: 11, color: C.text, fontFamily: MONO, whiteSpace: 'nowrap' }}>{label}</div>
    </div>
  );
}

// Debtor ageing: five buckets, worst on the right.
export function AgeingBuckets({ buckets }) {
  const byName = Object.fromEntries((buckets || []).map((b) => [b.bucket, b]));
  const total = AGEING_BUCKETS.reduce((s, b) => s + (Number(byName[b]?.amount) || 0), 0);
  const tone = (b) => (b === 'current' ? '#86efac' : b === '1-30' ? '#fde047' : b === '31-60' ? '#fdba74' : '#fca5a5');
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 8 }}>
        {AGEING_BUCKETS.map((b) => (
          <div key={b} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.md, padding: '8px 10px', minWidth: 0 }}>
            <div style={{ fontSize: 10, color: C.textMuted, fontFamily: MONO, letterSpacing: 1 }}>{b === 'current' ? 'CURRENT' : `${b} DAYS`}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: tone(b), fontFamily: MONO, marginTop: 3, overflowWrap: 'anywhere' }}>{fmtMoney(byName[b]?.amount || 0)}</div>
            <div style={{ fontSize: 11, color: C.textDim }}>{Number(byName[b]?.item_count) || 0} invoice{Number(byName[b]?.item_count) === 1 ? '' : 's'}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: C.textMuted }}>Owed to us in total: <span style={{ color: C.text, fontFamily: MONO, fontWeight: 600 }}>{fmtMoney(total)}</span></div>
    </div>
  );
}

export function Pill({ active, onClick, children, count }) {
  return (
    <button onClick={onClick} style={{
      background: active ? C.accentSoft : 'transparent', color: active ? '#fdba74' : C.textMuted,
      border: `1px solid ${active ? C.accentBorder : C.border}`, borderRadius: R.pill, padding: '7px 13px',
      fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', minHeight: 36,
    }}>
      {children}{count !== undefined && count !== null ? <span style={{ marginLeft: 6, fontFamily: MONO, fontSize: 11, opacity: 0.85 }}>{count}</span> : null}
    </button>
  );
}

// ── v2 primitives (2026-11-10) ──────────────────────────────────────────────

// Phone-first breakpoint hook shared by every Books tab.
export function useNarrow(px = 640) {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < px);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${px - 1}px)`);
    const on = () => setNarrow(mq.matches);
    on(); mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [px]);
  return narrow;
}

// Right-aligned money in MONO, red for negatives when `signed`.
export function Num({ v, signed = false, bold = false, size = 13, pct = false, color }) {
  const n = Number(v);
  const bad = signed && Number.isFinite(n) && n < 0;
  const good = signed && Number.isFinite(n) && n > 0;
  const text = pct ? (Number.isFinite(n) ? `${n.toFixed(1)}%` : '—') : fmtMoney(v);
  return <span style={{ fontFamily: MONO, fontSize: size, fontWeight: bold ? 700 : 500, color: color || (bad ? '#fca5a5' : good ? '#86efac' : C.text), whiteSpace: 'nowrap' }}>{text}</span>;
}

// Segmented control (the dimension picker on Margin, the view on P&L).
export function Seg({ options, value, onChange }) {
  return (
    <div role="tablist" style={{ display: 'inline-flex', background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.md, padding: 2, maxWidth: '100%', overflowX: 'auto' }}>
      {options.map(([v, label]) => (
        <button key={v} role="tab" aria-selected={value === v} onClick={() => onChange(v)} style={{
          background: value === v ? C.cardHover : 'transparent', color: value === v ? C.text : C.textMuted,
          border: 'none', borderRadius: R.sm, padding: '7px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', minHeight: 34,
        }}>{label}</button>
      ))}
    </div>
  );
}

export function CsvButton({ rows, filename, label = 'CSV' }) {
  return <button onClick={() => downloadCSV(filename, rows || [])} disabled={!rows?.length} style={{ ...btnSmall, minHeight: 34, opacity: rows?.length ? 1 : 0.5 }} aria-label={`Download ${filename}`}>⬇ {label}</button>;
}

// One table that stacks into cards on a phone.
// cols: [{ key, label, align, render(row) }]  — render returns a node.
// On a phone the first column is the card title; the rest are label/value lines.
export function Rows({ cols, rows, narrow, keyOf, empty = 'Nothing here.', foot, onRow }) {
  if (!rows?.length) return <div style={{ color: C.textDim, fontSize: 13, padding: '8px 0' }}>{empty}</div>;
  if (narrow) {
    const [head, ...rest] = cols;
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map((r, i) => (
          <div key={keyOf ? keyOf(r, i) : i} onClick={onRow ? () => onRow(r) : undefined} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.md, padding: '10px 12px', display: 'grid', gap: 5, cursor: onRow ? 'pointer' : 'default' }}>
            <div style={{ color: C.text, fontWeight: 600, fontSize: 13, overflowWrap: 'anywhere' }}>{head.render ? head.render(r) : r[head.key]}</div>
            {rest.map((c) => (
              <div key={c.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, color: C.textMuted, alignItems: 'baseline' }}>
                <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', flex: '0 0 auto' }}>{c.label}</span>
                <span style={{ textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' }}>{c.render ? c.render(r) : r[c.key]}</span>
              </div>
            ))}
          </div>
        ))}
        {foot}
      </div>
    );
  }
  return (
    <TableWrap>
      <thead><tr>{cols.map((c) => <Th key={c.key} align={c.align || 'left'}>{c.label}</Th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={keyOf ? keyOf(r, i) : i} onClick={onRow ? () => onRow(r) : undefined} style={{ cursor: onRow ? 'pointer' : 'default' }}>
            {cols.map((c) => <Td key={c.key} align={c.align || 'left'}>{c.render ? c.render(r) : r[c.key]}</Td>)}
          </tr>
        ))}
      </tbody>
      {foot ? <tfoot><tr><td colSpan={cols.length} style={{ padding: '8px 14px' }}>{foot}</td></tr></tfoot> : null}
    </TableWrap>
  );
}

// Label → value line (settings, snapshot panels).
export function KV({ k, v, hint }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline', fontSize: 13, padding: '6px 0', borderBottom: `1px solid ${C.border}` }}>
      <span style={{ color: C.textMuted, minWidth: 0 }}>{k}{hint ? <span style={{ color: C.textDim, fontSize: 11, marginLeft: 6 }}>{hint}</span> : null}</span>
      <span style={{ textAlign: 'right' }}>{v}</span>
    </div>
  );
}

// Small inline input for a money / number setting.
export function MiniInput({ value, onChange, type = 'number', width = 120, placeholder, ariaLabel, step }) {
  return <input type={type} value={value ?? ''} step={step} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={ariaLabel}
    style={{ ...inputStyle, width, minHeight: 36, padding: '6px 9px', fontFamily: type === 'number' ? MONO : undefined, textAlign: type === 'number' ? 'right' : 'left' }} />;
}

// Demo-data banner + remove button.
export function DemoBanner({ count, onRemove, busy }) {
  if (!count) return null;
  return (
    <div role="status" style={{ background: 'rgba(168,85,247,0.12)', border: '1px solid rgba(168,85,247,0.4)', borderRadius: R.lg, padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <Badge label="Demo data" color="purple" />
      <span style={{ color: C.text, fontSize: 13, flex: '1 1 160px' }}>{count} sample row{count === 1 ? '' : 's'} are mixed into these figures.</span>
      <button onClick={onRemove} disabled={busy} style={{ ...btnSmall, minHeight: 36, opacity: busy ? 0.6 : 1 }}>{busy ? 'Removing…' : 'Remove demo data'}</button>
    </div>
  );
}

export const tabBtn = (active) => ({
  background: active ? C.accentSoft : 'transparent', color: active ? '#fdba74' : C.textMuted,
  border: `1px solid ${active ? C.accentBorder : C.border}`, borderRadius: R.pill, padding: '7px 13px',
  fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', minHeight: 36,
});
