import { C, R, MONO } from '../../theme';
import { fmtMoney, monthLabel, AGEING_BUCKETS } from '../../utils/books';

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
