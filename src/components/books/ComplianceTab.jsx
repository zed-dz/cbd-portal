import { useMemo, useState, useEffect } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle, btnPrimary } from '../../theme';
import { Badge } from '../index';
import { Card, Stat, Num, KV, CsvButton, MiniInput } from './BooksBits';
import { upcomingObligations, complianceEstimates, PAYDAY_SUPER_FROM } from '../../utils/booksCompliance';
import { weeklyPayroll } from '../../utils/booksForecast';
import { fmtMoney } from '../../utils/books';
import { fmtDate } from '../../utils/dates';
import { saveSnapshot } from './useBooksData';

// BAS · PAYG withholding · super, with countdowns and estimates. A daily cron
// (books-compliance) raises a bell notification 14 and 3 days out.

const TYPE_LABEL = { bas: 'BAS', payg: 'PAYG W', super: 'Super' };
const TYPE_COLOR = { bas: 'orange', payg: 'blue', super: 'green' };

export function ComplianceTab({ data, narrow, who, showToast }) {
  const { settings, bas, quarter, transactions, today, patch } = data;
  const [form, setForm] = useState({ bas_cycle: 'quarterly', payg_cycle: 'monthly', payroll_frequency: 'weekly', payroll_weekday: 4, super_rate_pct: 12, payg_rate_pct: 20 });
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (settings) setForm({ bas_cycle: settings.bas_cycle || 'quarterly', payg_cycle: settings.payg_cycle || 'monthly', payroll_frequency: settings.payroll_frequency || 'weekly', payroll_weekday: settings.payroll_weekday ?? 4, super_rate_pct: settings.super_rate_pct ?? 12, payg_rate_pct: settings.payg_rate_pct ?? 20 }); }, [settings]);

  const liveTx = useMemo(() => transactions.filter((t) => t.is_cash && ['AUTHORISED', 'PAID'].includes(String(t.status || 'AUTHORISED').toUpperCase())), [transactions]);
  const payroll = useMemo(() => weeklyPayroll(liveTx, today), [liveTx, today]);
  // Gross pay in the open period ≈ weeks in the period so far × weekly wages.
  const weeksSoFar = Math.max(1, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${quarter.from}T12:00:00Z`)) / (7 * 86400000)));
  const estimates = useMemo(() => complianceEstimates({ bas, grossPay: payroll.weekly * (form.payg_cycle === 'monthly' ? 4 : weeksSoFar), settings: form }), [bas, payroll, form, weeksSoFar]);
  const list = useMemo(() => upcomingObligations(today, form, estimates, 3), [today, form, estimates]);

  useEffect(() => { saveSnapshot('compliance', { as_at: today, estimates, obligations: list, settings: form }, who); }, [today, estimates, list, form, who]);

  const save = async () => {
    setSaving(true);
    const row = { ...form, payroll_weekday: Number(form.payroll_weekday), super_rate_pct: Number(form.super_rate_pct), payg_rate_pct: Number(form.payg_rate_pct), updated_by: who || null, updated_at: new Date().toISOString() };
    const { error } = await supabase.from('books_settings').update(row).eq('id', 1);
    if (error) showToast?.(error.message, 'error'); else { patch({ settings: { ...settings, ...row } }); showToast?.('Compliance settings saved.', 'success'); }
    setSaving(false);
  };

  const next = list[0];
  const csv = list.map((o) => ({ 'Obligation': o.label, 'Period from': o.period?.from || '', 'Period to': o.period?.to || '', 'Due': o.due, 'Days left': o.days_left, 'Estimate $': o.amount === null || o.amount === undefined ? '' : Number(o.amount).toFixed(2) }));

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: narrow ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
        <Stat label="Next due" value={next ? fmtDate(next.due) : '—'} hint={next ? `${next.label} · ${next.days_left} d` : undefined} />
        <Stat label="GST net · est." value={fmtMoney(estimates.gst_net)} hint={`${quarter.label} so far`} tone={estimates.gst_net > 0 ? 'out' : 'in'} />
        <Stat label="PAYG W · est." value={fmtMoney(estimates.payg_w)} hint={`${form.payg_rate_pct}% of wages`} />
        <Stat label="Super · est." value={fmtMoney(estimates.super)} hint={`${form.super_rate_pct}% of wages`} />
      </div>

      <Card title="Calendar" right={<CsvButton rows={csv} filename={`compliance-${today}.csv`} />}>
        <div style={{ display: 'grid', gap: 8 }}>
          {list.map((o) => {
            const tone = o.days_left <= 3 ? '#fca5a5' : o.days_left <= 14 ? '#fde047' : C.text;
            const border = o.days_left <= 3 ? 'rgba(239,68,68,0.4)' : o.days_left <= 14 ? 'rgba(234,179,8,0.4)' : C.border;
            const sub = o.note || `${fmtDate(o.period.from)} → ${fmtDate(o.period.to)}`;
            const amt = o.amount === null || o.amount === undefined ? <span style={{ color: C.textDim, fontSize: 12 }}>—</span> : <Num v={o.amount} />;
            return narrow ? (
              <div key={o.key} style={{ display: 'grid', gap: 4, background: C.bg, border: `1px solid ${border}`, borderRadius: R.md, padding: '10px 12px' }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><Badge label={TYPE_LABEL[o.type]} color={TYPE_COLOR[o.type]} size="sm" /><span style={{ fontSize: 13, color: C.text, overflowWrap: 'anywhere' }}>{o.label}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ fontFamily: MONO, fontSize: 13, color: tone }}>{fmtDate(o.due)} · {o.days_left} d</span>{amt}
                </div>
                <div style={{ fontSize: 11, color: C.textDim }}>{sub}</div>
              </div>
            ) : (
              <div key={o.key} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 10, alignItems: 'center', background: C.bg, border: `1px solid ${border}`, borderRadius: R.md, padding: '10px 12px' }}>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}><Badge label={TYPE_LABEL[o.type]} color={TYPE_COLOR[o.type]} size="sm" /><span style={{ fontSize: 13, color: C.text, overflowWrap: 'anywhere' }}>{o.label}</span></span>
                <span style={{ fontSize: 11, color: C.textDim }}>{sub}</span>
                <span style={{ fontFamily: MONO, fontSize: 13, color: tone, textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtDate(o.due)} · {o.days_left} d</span>
                <span style={{ textAlign: 'right', minWidth: 90 }}>{amt}</span>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: C.textDim, marginTop: 8 }}>
          Reminders land in the bell 14 and 3 days before each date. {today >= PAYDAY_SUPER_FROM ? 'Payday Super: contributions reach the fund within 7 business days of each pay day.' : 'Super is due 28 days after the quarter until 30 Jun 2026.'}
        </div>
      </Card>

      <Card title="Settings">
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: narrow ? '1fr 1fr' : 'repeat(3, minmax(0, 1fr))' }}>
          <label style={{ fontSize: 11, color: C.textMuted }}>BAS
            <select value={form.bas_cycle} onChange={(e) => setForm({ ...form, bas_cycle: e.target.value })} style={{ ...inputStyle, minHeight: 40, marginTop: 4 }}><option value="quarterly">Quarterly</option><option value="monthly">Monthly</option></select></label>
          <label style={{ fontSize: 11, color: C.textMuted }}>PAYG withholding
            <select value={form.payg_cycle} onChange={(e) => setForm({ ...form, payg_cycle: e.target.value })} style={{ ...inputStyle, minHeight: 40, marginTop: 4 }}><option value="monthly">Monthly (IAS)</option><option value="quarterly">Quarterly (with BAS)</option></select></label>
          <label style={{ fontSize: 11, color: C.textMuted }}>Pay run
            <select value={form.payroll_frequency} onChange={(e) => setForm({ ...form, payroll_frequency: e.target.value })} style={{ ...inputStyle, minHeight: 40, marginTop: 4 }}><option value="weekly">Weekly</option><option value="fortnightly">Fortnightly</option></select></label>
          <label style={{ fontSize: 11, color: C.textMuted }}>Pay day
            <select value={form.payroll_weekday} onChange={(e) => setForm({ ...form, payroll_weekday: Number(e.target.value) })} style={{ ...inputStyle, minHeight: 40, marginTop: 4 }}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>
          <label style={{ fontSize: 11, color: C.textMuted }}>Super %<div style={{ marginTop: 4 }}><MiniInput value={form.super_rate_pct} onChange={(v) => setForm({ ...form, super_rate_pct: v })} width="100%" step="0.5" ariaLabel="Super rate" /></div></label>
          <label style={{ fontSize: 11, color: C.textMuted }}>PAYG % of wages<div style={{ marginTop: 4 }}><MiniInput value={form.payg_rate_pct} onChange={(v) => setForm({ ...form, payg_rate_pct: v })} width="100%" step="0.5" ariaLabel="PAYG rate" /></div></label>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: C.textDim }}>Wages/week used: {fmtMoney(payroll.weekly)} ({payroll.source === 'bank' ? `${payroll.weeks} wage weeks in the bank` : 'no wage lines yet'})</span>
          <button onClick={save} disabled={saving} style={{ ...btnPrimary, minHeight: 38 }}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </Card>

      <Card title="BAS figures · cash basis">
        <KV k="G1 total sales" v={<Num v={bas?.g1} />} />
        <KV k="G11 non-capital purchases" v={<Num v={bas?.g11} />} />
        <KV k="1A GST on sales" v={<Num v={bas?.gst_1a} />} />
        <KV k="1B GST on purchases" v={<Num v={bas?.gst_1b} />} />
        <KV k="Net GST" v={<Num v={(Number(bas?.gst_1a) || 0) - (Number(bas?.gst_1b) || 0)} bold />} hint={quarter.label} />
      </Card>
    </div>
  );
}
