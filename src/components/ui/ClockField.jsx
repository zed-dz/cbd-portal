import { useState, useRef, useEffect } from 'react';
import { C, R, MONO, inputStyle, btnPrimary } from '../../theme';

// Analog clock time picker (feedback: "a drop down analog clock to select time
// AM and PM"). Pick the hour on the clock face, then the minutes (5-minute
// steps), with an AM/PM toggle. Emits 24-hour 'HH:MM'. No dependencies.

const FACE = 216;                 // px, clock face size
const RADIUS = FACE / 2 - 24;     // number ring radius

const to12 = (hhmm) => {
  if (!hhmm) return { h: 7, m: 0, pm: false };   // sensible site-start default
  const [H, M] = hhmm.split(':').map(Number);
  return { h: ((H + 11) % 12) + 1, m: M || 0, pm: H >= 12 };
};
const to24 = (h, m, pm) => {
  const H = pm ? (h % 12) + 12 : h % 12;
  return `${String(H).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
const prettyTime = (hhmm) => {
  if (!hhmm) return '';
  const { h, m, pm } = to12(hhmm);
  return `${h}:${String(m).padStart(2, '0')} ${pm ? 'PM' : 'AM'}`;
};

export function ClockField({ value, onChange, placeholder = 'Pick a time…' }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState('hour');    // 'hour' | 'minute'
  const [sel, setSel] = useState(to12(value));
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc); };
  }, [open]);

  const openClock = () => { setSel(to12(value)); setPhase('hour'); setOpen(o => !o); };
  const commit = (next) => { setSel(next); onChange(to24(next.h, next.m, next.pm)); };

  // Angle for the hand: 12 at the top, clockwise.
  const handDeg = phase === 'hour' ? (sel.h % 12) * 30 : (sel.m / 5) * 30;

  const marks = phase === 'hour'
    ? Array.from({ length: 12 }, (_, i) => ({ label: String(i + 1), val: i + 1, deg: ((i + 1) % 12) * 30 }))
    : Array.from({ length: 12 }, (_, i) => ({ label: String(i * 5).padStart(2, '0'), val: i * 5, deg: i * 30 }));

  const meridiemBtn = (pm) => ({
    flex: 1, padding: '6px 0', fontSize: 12, fontWeight: 700, cursor: 'pointer',
    borderRadius: R.sm, border: `1px solid ${sel.pm === pm ? C.accentBorder : C.border}`,
    background: sel.pm === pm ? C.accentSoft : 'transparent',
    color: sel.pm === pm ? C.accent : C.textMuted,
  });

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button type="button" onClick={openClock}
        style={{ ...inputStyle, width: '100%', textAlign: 'left', cursor: 'pointer', color: value ? C.text : C.textDim, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{value ? prettyTime(value) : placeholder}</span>
        <span aria-hidden style={{ opacity: 0.7 }}>🕐</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute', zIndex: 60, top: 'calc(100% + 6px)', left: 0, width: FACE + 32,
          background: C.card, border: `1px solid ${C.borderStrong || C.border}`, borderRadius: R.lg,
          boxShadow: '0 18px 40px -12px rgba(0,0,0,0.65)', padding: 16, animation: 'fadeIn 120ms',
        }}>
          {/* Digital readout — tap hour/minute to switch phase */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 12, fontFamily: MONO }}>
            <button type="button" onClick={() => setPhase('hour')}
              style={{ fontSize: 24, fontWeight: 800, background: 'none', border: 'none', cursor: 'pointer', color: phase === 'hour' ? C.accent : C.text }}>
              {sel.h}
            </button>
            <span style={{ fontSize: 24, fontWeight: 800, color: C.textMuted }}>:</span>
            <button type="button" onClick={() => setPhase('minute')}
              style={{ fontSize: 24, fontWeight: 800, background: 'none', border: 'none', cursor: 'pointer', color: phase === 'minute' ? C.accent : C.text }}>
              {String(sel.m).padStart(2, '0')}
            </button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginLeft: 10, width: 52 }}>
              <button type="button" style={meridiemBtn(false)} onClick={() => commit({ ...sel, pm: false })}>AM</button>
              <button type="button" style={meridiemBtn(true)} onClick={() => commit({ ...sel, pm: true })}>PM</button>
            </div>
          </div>

          {/* Clock face */}
          <div style={{ position: 'relative', width: FACE, height: FACE, margin: '0 auto', borderRadius: '50%', background: C.bg, border: `1px solid ${C.border}` }}>
            <div style={{ position: 'absolute', left: '50%', top: '50%', width: 6, height: 6, marginLeft: -3, marginTop: -3, borderRadius: '50%', background: C.accent }} />
            <div style={{
              position: 'absolute', left: '50%', top: '50%', width: 2, height: RADIUS - 14,
              background: C.accent, transformOrigin: 'top center',
              transform: `rotate(${handDeg + 180}deg)`, opacity: 0.8,
            }} />
            {marks.map(({ label, val, deg }) => {
              const rad = (deg - 90) * Math.PI / 180;
              const x = FACE / 2 + RADIUS * Math.cos(rad);
              const y = FACE / 2 + RADIUS * Math.sin(rad);
              const active = phase === 'hour' ? sel.h === val : sel.m === val;
              return (
                <button key={label} type="button"
                  onClick={() => {
                    if (phase === 'hour') { commit({ ...sel, h: val }); setPhase('minute'); }
                    else commit({ ...sel, m: val });
                  }}
                  style={{
                    position: 'absolute', left: x - 16, top: y - 16, width: 32, height: 32,
                    borderRadius: '50%', border: 'none', cursor: 'pointer',
                    background: active ? C.accent : 'transparent',
                    color: active ? '#fff' : C.text, fontSize: 12.5, fontWeight: active ? 700 : 500,
                  }}>
                  {label}
                </button>
              );
            })}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
            <span style={{ fontSize: 11, color: C.textMuted }}>{phase === 'hour' ? 'Pick the hour' : 'Pick the minutes'}</span>
            <button type="button" style={{ ...btnPrimary, padding: '6px 18px', fontSize: 12.5 }} onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
