import { useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO } from '../../theme';

// "Notes for payroll" inside the Payroll tracker: every note the allocator
// wrote on the Allocation Board for a day inside the pay period, plus the days
// flagged rain / left early / sick / leave without a written note. Read these
// before processing — the same list the board shows, filtered to the period.

const STATUS_LABEL = { personal_leave: 'Sick', annual_leave: 'A/L', injured: 'Injured', public_holiday: 'Public holiday', rdo: 'RDO' };
const SHIFT_LABEL = { night: 'Night shift', rain_4: 'Rain 4hrs', rain_8: 'Rain day 8 hours', rain_unpaid: 'Rain day – unpaid' };
const fmt = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });

export default function PayrollNotesPanel({ from, to }) {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!from || !to) { setRows([]); return; }
    let alive = true;
    (async () => {
      const [n, a] = await Promise.all([
        supabase.from('allocation_day_notes').select('id, worker_id, day, note, allocation_id, workers(name)').gte('day', from).lte('day', to).order('day'),
        supabase.from('allocations').select('id, worker_id, client, site, allocation_type, shift, left_early, start_date, end_date, status, workers(name)')
          .in('status', ['pending', 'confirmed', 'completed']).lte('start_date', to).or(`end_date.gte.${from},and(end_date.is.null,start_date.gte.${from})`),
      ]);
      if (!alive) return;
      const out = [];
      const noted = new Set();
      (n.data || []).forEach(x => {
        noted.add(`${x.worker_id}|${x.day}`);
        const al = (a.data || []).find(y => y.id === x.allocation_id);
        const tag = al ? ((al.allocation_type || 'work') === 'work' ? [al.client, al.site].filter(Boolean).join(' · ') : (STATUS_LABEL[al.allocation_type] || al.allocation_type)) : '';
        out.push({ key: x.id, day: x.day, name: x.workers?.name || 'Worker', text: x.note, tag });
      });
      (a.data || []).forEach(al => {
        const flags = [];
        if ((al.allocation_type || 'work') !== 'work') flags.push(STATUS_LABEL[al.allocation_type] || al.allocation_type);
        if (SHIFT_LABEL[al.shift]) flags.push(SHIFT_LABEL[al.shift]);
        if (al.left_early) flags.push('Left early');
        if (!flags.length) return;
        const end = al.end_date || al.start_date;
        for (let d = al.start_date; d && d <= end && d <= to; d = (() => { const t = new Date(d + 'T12:00:00'); t.setDate(t.getDate() + 1); return t.toISOString().slice(0, 10); })()) {
          if (d < from || noted.has(`${al.worker_id}|${d}`)) continue;
          out.push({ key: `${al.id}|${d}`, day: d, name: al.workers?.name || 'Worker', text: flags.join(' · '), tag: (al.allocation_type || 'work') === 'work' ? [al.client, al.site].filter(Boolean).join(' · ') : '', auto: true });
        }
      });
      out.sort((x, y) => x.day.localeCompare(y.day) || x.name.localeCompare(y.name));
      setRows(out);
    })();
    return () => { alive = false; };
  }, [from, to]);

  if (!from || !to || rows.length === 0) return null;
  return (
    <div style={{ background: C.card, border: `1px solid ${C.accentBorder}`, borderRadius: R.lg, padding: '12px 14px', marginBottom: 14 }} data-area="payroll notes">
      <button type="button" onClick={() => setOpen(o => !o)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: C.accent, fontWeight: 900, fontSize: 15, textTransform: 'uppercase', fontFamily: 'inherit', display: 'flex', gap: 8, alignItems: 'center' }}>
        <span>{open ? '▾' : '▸'}</span> Notes for payroll <span style={{ color: C.textMuted, fontSize: 12, fontWeight: 600, textTransform: 'none' }}>{rows.length} in this period — read before processing</span>
      </button>
      {open && (
        <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
          {rows.map(r => (
            <div key={r.key} style={{ borderLeft: `3px solid ${r.auto ? C.border : C.accent}`, background: C.bg, borderRadius: 8, padding: '7px 11px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <span style={{ fontWeight: 700, color: C.text, fontSize: 13 }}>{r.name}</span>
                <span style={{ color: r.auto ? C.textMuted : C.text, fontSize: 13, marginLeft: 8 }}>{r.text}</span>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: 1, textTransform: 'uppercase', color: C.accent, fontWeight: 700, whiteSpace: 'nowrap' }}>{fmt(r.day)}{r.tag ? ` · ${r.tag}` : ''}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
