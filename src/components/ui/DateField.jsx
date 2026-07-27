import { useState, useRef, useEffect } from 'react';
import { C, R, inputStyle } from '../../theme';

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const pretty = (v) => {
  if (!v) return '';
  const d = new Date(v + 'T12:00:00');
  return isNaN(d) ? '' : d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
};

// Click-a-date dropdown calendar (feedback: "instead of writing in the date").
// Emits 'YYYY-MM-DD'. Pure design-system component — no dependencies.
export function DateField({ value, onChange, placeholder = 'Pick a date…' }) {
  const [open, setOpen] = useState(false);
  const seed = value ? new Date(value + 'T12:00:00') : new Date();
  const [viewYear, setViewYear] = useState(seed.getFullYear());
  const [viewMonth, setViewMonth] = useState(seed.getMonth());
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc); };
  }, [open]);

  const openCal = () => {
    const d = value ? new Date(value + 'T12:00:00') : new Date();
    setViewYear(d.getFullYear()); setViewMonth(d.getMonth());
    setOpen(o => !o);
  };

  const shift = (n) => {
    const d = new Date(viewYear, viewMonth + n, 1);
    setViewYear(d.getFullYear()); setViewMonth(d.getMonth());
  };

  // Monday-first 6x7 grid covering the viewed month.
  const first = new Date(viewYear, viewMonth, 1);
  const gridStart = new Date(first);
  gridStart.setDate(1 - ((first.getDay() + 6) % 7));
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart); d.setDate(gridStart.getDate() + i); return d;
  });
  const todayIso = iso(new Date());

  const navBtn = { background: 'none', border: `1px solid ${C.border}`, borderRadius: R.sm, color: C.text, cursor: 'pointer', padding: '2px 10px', fontSize: 14 };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button type="button" onClick={openCal}
        style={{ ...inputStyle, width: '100%', textAlign: 'left', cursor: 'pointer', color: value ? C.text : C.textDim, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{value ? pretty(value) : placeholder}</span>
        <span aria-hidden style={{ opacity: 0.7 }}>📅</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute', zIndex: 60, top: 'calc(100% + 6px)', left: 0, width: 272,
          background: C.card, border: `1px solid ${C.borderStrong || C.border}`, borderRadius: R.lg,
          boxShadow: '0 18px 40px -12px rgba(0,0,0,0.65)', padding: 12, animation: 'fadeIn 120ms',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <button type="button" style={navBtn} onClick={() => shift(-1)}>‹</button>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 13 }}>{MONTHS[viewMonth]} {viewYear}</div>
            <button type="button" style={navBtn} onClick={() => shift(1)}>›</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 2 }}>
            {DAYS.map(d => <div key={d} style={{ textAlign: 'center', fontSize: 10, color: C.textMuted, padding: '2px 0', fontWeight: 600 }}>{d}</div>)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
            {cells.map((d, i) => {
              const dIso = iso(d);
              const inMonth = d.getMonth() === viewMonth;
              const selected = value === dIso;
              const isToday = dIso === todayIso;
              return (
                <button key={i} type="button"
                  onClick={() => { onChange(dIso); setOpen(false); }}
                  style={{
                    padding: '6px 0', fontSize: 12.5, borderRadius: R.sm, cursor: 'pointer',
                    border: isToday && !selected ? `1px solid ${C.accentBorder}` : '1px solid transparent',
                    background: selected ? C.accent : 'transparent',
                    color: selected ? '#fff' : inMonth ? C.text : C.textDim,
                    fontWeight: selected || isToday ? 700 : 400,
                  }}>
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
            <button type="button" style={{ ...navBtn, fontSize: 12 }} onClick={() => { onChange(todayIso); setOpen(false); }}>Today</button>
            <button type="button" style={{ ...navBtn, fontSize: 12, color: C.textMuted }} onClick={() => { onChange(''); setOpen(false); }}>Clear</button>
          </div>
        </div>
      )}
    </div>
  );
}
