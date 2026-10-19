import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { C, btnPrimary } from '../../theme';
import { todayISO, fmtDateTime, sydneyTime } from '../../utils/dates';
import { Spinner, timesheetBadge } from '../index';

// Clock in / out — server-side (2026-10-19). Replaces the localStorage timer:
// every tap writes a `clock_events` row with the time and, when the phone
// allows it, the GPS fix. The running timer is read back from the open 'in'
// row, so a reload, a dead battery or a second device all show the same
// state. Clock out still turns the day into a daily sheet exactly like
// before (save_daily_timesheet from today's accepted allocation) and links
// both events to that the office sees "clocked in 06:58 · map".

const GPS_TIMEOUT_MS = 10_000;

// Resolves to { lat, lng, accuracy_m } or null (refused / unavailable / slow).
function getPosition() {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { resolve(null); return; }
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(null), GPS_TIMEOUT_MS + 500);
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => { clearTimeout(timer); finish({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy_m: pos.coords.accuracy ?? null }); },
        () => { clearTimeout(timer); finish(null); },
        { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 60_000 },
      );
    } catch { clearTimeout(timer); finish(null); }
  });
}

const deviceLabel = () => {
  try { return String(navigator.userAgent || '').slice(0, 120); } catch { return null; }
};

export function ClockInOut({ currentWorker, showToast }) {
  const [now, setNow] = useState(new Date());
  const [openIn, setOpenIn] = useState(null);       // the open 'in' clock_events row, if any
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [todayEntries, setTodayEntries] = useState([]);
  const [recent, setRecent] = useState([]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // State of play from the server: the newest event decides. An 'in' with no
  // later 'out' = still clocked in.
  const load = useCallback(async () => {
    const [{ data: ev }, { data: ts }] = await Promise.all([
      supabase.from('clock_events').select('*').eq('worker_id', currentWorker.id).order('at', { ascending: false }).limit(10),
      supabase.from('timesheets').select('*').eq('worker_id', currentWorker.id).eq('date', todayISO()).order('created_at', { ascending: false }),
    ]);
    const list = ev || [];
    setOpenIn(list[0]?.kind === 'in' ? list[0] : null);
    setRecent(list);
    setTodayEntries(ts || []);
    setLoading(false);
  }, [currentWorker.id]);

  useEffect(() => { load(); }, [load]);

  // Today's accepted allocation — the sheet's client / project / role come from it.
  const todaysAllocation = async () => {
    const today = todayISO();
    const { data } = await supabase.from('allocations')
      .select('id, client, project, site, role')
      .eq('worker_id', currentWorker.id)
      .in('status', ['confirmed', 'completed'])
      .lte('start_date', today)
      .or(`end_date.is.null,end_date.gte.${today}`)
      .order('start_date', { ascending: false })
      .limit(1);
    return data?.[0] || null;
  };

  const clockIn = async () => {
    setBusy(true);
    const [gps, alloc] = await Promise.all([getPosition(), todaysAllocation()]);
    const { data, error } = await supabase.from('clock_events').insert([{
      worker_id: currentWorker.id, kind: 'in',
      lat: gps?.lat ?? null, lng: gps?.lng ?? null, accuracy_m: gps?.accuracy_m ?? null,
      allocation_id: alloc?.id || null, device: deviceLabel(),
    }]).select().single();
    setBusy(false);
    if (error) { showToast(error.message, 'error'); return; }
    setOpenIn(data);
    showToast(`Clocked in at ${sydneyTime(data.at)}${gps ? '' : ' (no GPS)'}`, 'success');
    load();
  };

  const clockOut = async () => {
    if (!openIn) return;
    setBusy(true);
    const [gps, alloc] = await Promise.all([getPosition(), todaysAllocation()]);
    const { data: outEv, error: outErr } = await supabase.from('clock_events').insert([{
      worker_id: currentWorker.id, kind: 'out',
      lat: gps?.lat ?? null, lng: gps?.lng ?? null, accuracy_m: gps?.accuracy_m ?? null,
      allocation_id: alloc?.id || openIn.allocation_id || null, device: deviceLabel(),
    }]).select().single();
    if (outErr) { setBusy(false); showToast(outErr.message, 'error'); return; }

    const inAt = new Date(openIn.at);
    const outAt = new Date(outEv.at);
    // Hours round to 0.25 h like every other timesheet line.
    const hours = Math.max(0, Math.round(((outAt - inAt) / 3_600_000) * 4) / 4);

    if (!alloc || !alloc.client) {
      setBusy(false);
      setOpenIn(null);
      showToast('Clocked out. No accepted allocation for today, so open My Timesheets and fill in the sheet yourself.', 'info');
      load();
      return;
    }

    const today = todayISO();
    const { data: headerId, error } = await supabase.rpc('save_daily_timesheet', {
      p_header_id: null,
      p_worker_id: currentWorker.id,
      p_client: alloc.client,
      p_project: alloc.project || alloc.site || alloc.client,
      p_role: alloc.role || currentWorker.job_title || 'General Labourer',
      p_wet_hire: false,
      p_comments: 'Clock in / out',
      p_client_signature: null,
      p_allowance_lines: [],
      p_status: 'pending',
      p_lines: [{
        date: today, shift_type: 'Day', scenario: 'standard',
        start_time: inAt.toISOString(), end_time: outAt.toISOString(),
        total_break_hours: 0, total_hours: hours, regular_hours: hours,
        meal_allowance: 0, meal_allowance_override: false,
      }],
    });
    if (error) {
      showToast(`Clocked out, but the daily sheet failed: ${error.message}`, 'error');
    } else {
      if (headerId) {
        await supabase.from('clock_events').update({ header_id: headerId }).in('id', [openIn.id, outEv.id]);
      }
      showToast(`Clocked out — ${hours} hours logged`, 'success');
    }
    setOpenIn(null);
    setBusy(false);
    load();
  };

  const elapsed = openIn ? Math.max(0, Math.floor((now - new Date(openIn.at)) / 1000)) : 0;
  const elapsedStr = `${String(Math.floor(elapsed / 3600)).padStart(2, '0')}:${String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  const gpsLabel = (e) => (e.lat != null && e.lng != null)
    ? <a href={`https://maps.google.com/?q=${e.lat},${e.lng}`} target="_blank" rel="noreferrer" style={{ color: '#93c5fd', textDecoration: 'none' }}>📍 map{e.accuracy_m ? ` ±${Math.round(e.accuracy_m)} m` : ''}</a>
    : <span style={{ color: C.textDim }}>no GPS</span>;

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>;

  return (
    <div data-area="clock in / out" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 12 }}>
      <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, padding: '28px 20px', textAlign: 'center', maxWidth: 380, width: '100%', boxSizing: 'border-box' }}>
        <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 8 }}>{now.toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
        <div style={{ fontSize: 44, fontWeight: 800, color: C.text, fontVariantNumeric: 'tabular-nums', letterSpacing: 2 }}>
          {now.toLocaleTimeString('en-AU', { timeStyle: 'medium' })}
        </div>

        {openIn && (
          <div style={{ marginTop: 16, padding: '10px 16px', background: '#16653a', borderRadius: 8 }}>
            <div style={{ color: '#4ade80', fontSize: 13 }}>Clocked in at {sydneyTime(openIn.at)} · {gpsLabel(openIn)}</div>
            <div style={{ color: '#4ade80', fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{elapsedStr}</div>
          </div>
        )}

        <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!openIn ? (
            <button onClick={clockIn} disabled={busy} style={{ ...btnPrimary, background: C.success, fontSize: 16, padding: '14px 0', borderRadius: 8, opacity: busy ? 0.7 : 1 }}>
              {busy ? 'Getting your location…' : '▶ Clock In'}
            </button>
          ) : (
            <button onClick={clockOut} disabled={busy} style={{ ...btnPrimary, background: C.error, fontSize: 16, padding: '14px 0', borderRadius: 8, opacity: busy ? 0.7 : 1 }}>
              {busy ? 'Saving…' : '■ Clock Out'}
            </button>
          )}
          <div style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.5 }}>
            Your phone will ask for your location so the office can see where you clocked {openIn ? 'out' : 'in'}. If you say no, the time is still recorded.
          </div>
        </div>
      </div>

      {todayEntries.length > 0 && (
        <div style={{ marginTop: 24, width: '100%', maxWidth: 380 }}>
          <h4 style={{ color: C.textMuted, fontSize: 13, marginBottom: 10, textTransform: 'uppercase' }}>Today's entries</h4>
          {todayEntries.map(e => (
            <div key={e.id} style={{ background: C.card, borderRadius: 8, border: `1px solid ${C.border}`, padding: '12px 16px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div>
                <span style={{ color: C.text, fontWeight: 600 }}>{e.hours ?? e.total_hours} hrs</span>
                {e.start_time && <span style={{ color: C.textMuted, fontSize: 12, marginLeft: 8 }}>{fmtDateTime(e.start_time)} → {fmtDateTime(e.end_time)}</span>}
              </div>
              {timesheetBadge(e.status)}
            </div>
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <div style={{ marginTop: 20, width: '100%', maxWidth: 380 }}>
          <h4 style={{ color: C.textMuted, fontSize: 13, marginBottom: 10, textTransform: 'uppercase' }}>Recent clock events</h4>
          {recent.map(e => (
            <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: `1px solid ${C.border}`, fontSize: 12.5 }}>
              <span style={{ color: e.kind === 'in' ? '#4ade80' : '#fca5a5', fontWeight: 700, minWidth: 34 }}>{e.kind === 'in' ? 'IN' : 'OUT'}</span>
              <span style={{ color: C.text, flex: 1 }}>{fmtDateTime(e.at)}</span>
              <span>{gpsLabel(e)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
