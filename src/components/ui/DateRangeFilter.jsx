import { useState, useRef, useEffect } from 'react';
import { C, R, btnPrimary, btnSecondary } from '../../theme';
import { DateField } from './DateField';

// Date-range filter with a real calendar and the usual shortcuts, modelled on
// the picker the team already uses elsewhere: From/To calendars on top, a list
// of presets underneath, and Apply / Remove at the bottom.
//
// Emits { from, to } as 'YYYY-MM-DD' (or nulls for "no filter"). Dates are built
// from LOCAL parts — never toISOString(), which returns the UTC date and is a
// day behind in Australia for most of the working morning.

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const noon = () => { const d = new Date(); d.setHours(12, 0, 0, 0); return d; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
// Monday-start week, matching the AU pay week.
const monday = (d) => addDays(d, -((d.getDay() + 6) % 7));

export const RANGE_PRESETS = [
  { id: 'today',        label: 'Today' },
  { id: 'yesterday',    label: 'Yesterday' },
  { id: 'this_week',    label: 'Current week' },
  { id: 'this_month',   label: 'Current month' },
  { id: 'this_year',    label: 'Current year' },
  { id: 'past7',        label: 'Past 7 days' },
  { id: 'past30',       label: 'Past 30 days' },
  { id: 'last_week',    label: 'Last calendar week' },
  { id: 'last_month',   label: 'Last calendar month' },
  { id: 'last_year',    label: 'Last calendar year' },
];

export function presetBounds(id) {
  const t = noon();
  switch (id) {
    case 'today':      return [iso(t), iso(t)];
    case 'yesterday':  { const y = addDays(t, -1); return [iso(y), iso(y)]; }
    case 'this_week':  { const m = monday(t); return [iso(m), iso(addDays(m, 6))]; }
    case 'this_month': return [iso(new Date(t.getFullYear(), t.getMonth(), 1)), iso(new Date(t.getFullYear(), t.getMonth() + 1, 0))];
    case 'this_year':  return [iso(new Date(t.getFullYear(), 0, 1)), iso(new Date(t.getFullYear(), 11, 31))];
    case 'past7':      return [iso(addDays(t, -6)), iso(t)];
    case 'past30':     return [iso(addDays(t, -29)), iso(t)];
    case 'last_week':  { const m = addDays(monday(t), -7); return [iso(m), iso(addDays(m, 6))]; }
    case 'last_month': return [iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)), iso(new Date(t.getFullYear(), t.getMonth(), 0))];
    case 'last_year':  return [iso(new Date(t.getFullYear() - 1, 0, 1)), iso(new Date(t.getFullYear() - 1, 11, 31))];
    default:           return [null, null];
  }
}

const fmt = (v) => {
  if (!v) return '';
  const d = new Date(v + 'T12:00:00');
  return isNaN(d) ? '' : d.toLocaleDateString('en-AU');
};

export function DateRangeFilter({ from, to, onApply, label = 'Date range' }) {
  const [open, setOpen]   = useState(false);
  const [draftFrom, setDraftFrom] = useState(from || '');
  const [draftTo, setDraftTo]     = useState(to || '');
  const [preset, setPreset]       = useState('');
  const wrapRef = useRef(null);

  // Re-seed the draft whenever the popover opens, so cancelling leaves the
  // applied filter untouched.
  useEffect(() => {
    if (open) { setDraftFrom(from || ''); setDraftTo(to || ''); setPreset(''); }
  }, [open, from, to]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onEsc  = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc); };
  }, [open]);

  const pick = (id) => {
    const [a, b] = presetBounds(id);
    setPreset(id); setDraftFrom(a || ''); setDraftTo(b || '');
  };

  const apply = () => { onApply({ from: draftFrom || null, to: draftTo || null }); setOpen(false); };
  const clear = () => { onApply({ from: null, to: null }); setOpen(false); };

  const active  = !!(from || to);
  const summary = active ? `${fmt(from) || '…'} – ${fmt(to) || '…'}` : 'All dates';

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title={label}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 14px', borderRadius: R.md, cursor: 'pointer',
          background: active ? C.accentSoft : C.card,
          border: `1px solid ${active ? C.accentBorder : C.border}`,
          color: active ? C.text : C.textMuted, fontSize: 13, fontWeight: active ? 600 : 500,
        }}
      >
        <span>🗓</span>
        <span>{summary}</span>
        <span style={{ color: C.textDim, fontSize: 10 }}>▾</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 900,
          width: 320, background: C.card, border: `1px solid ${C.borderStrong}`,
          borderRadius: R.lg, boxShadow: '0 16px 48px rgba(0,0,0,0.45)', padding: 16,
        }}>
          <div style={{ display: 'grid', gap: 10, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, fontWeight: 600 }}>From</div>
              <DateField value={draftFrom} onChange={(v) => { setDraftFrom(v); setPreset(''); }} placeholder="Start date…" />
            </div>
            <div>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, fontWeight: 600 }}>To</div>
              <DateField value={draftTo} onChange={(v) => { setDraftTo(v); setPreset(''); }} placeholder="End date…" />
            </div>
          </div>

          <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10, maxHeight: 210, overflowY: 'auto' }}>
            {RANGE_PRESETS.map(p => (
              <label key={p.id} style={{
                display: 'flex', alignItems: 'center', gap: 9, padding: '6px 4px',
                cursor: 'pointer', borderRadius: R.sm,
                background: preset === p.id ? C.accentSoft : 'transparent',
              }}>
                <input
                  type="radio"
                  name="range-preset"
                  checked={preset === p.id}
                  onChange={() => pick(p.id)}
                  style={{ accentColor: C.accent, width: 14, height: 14 }}
                />
                <span style={{ fontSize: 13, color: preset === p.id ? C.text : C.textMuted }}>{p.label}</span>
              </label>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
            <button onClick={clear} disabled={!active} style={{ ...btnSecondary, padding: '7px 12px', fontSize: 12.5, opacity: active ? 1 : 0.45 }}>
              ↺ Remove filter
            </button>
            <button onClick={apply} style={{ ...btnPrimary, padding: '7px 14px', fontSize: 12.5 }}>
              ▼ Apply filter
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
