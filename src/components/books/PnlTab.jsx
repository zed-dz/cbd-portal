import { useMemo, useState } from 'react';
import { supabase } from '../../supabaseClient';
import { C, R, MONO, inputStyle } from '../../theme';
import { Card, Stat, Num, CsvButton, Seg, KV, MiniInput } from './BooksBits';
import { pnlByMonth, balanceSnapshot, budgetVsActual, pnlCSVRows } from '../../utils/booksPnl';
import { rollForwardBalance } from '../../utils/booksForecast';
import { fmtMoney, monthLabel } from '../../utils/books';

// Cash-basis P&L by month (chart-of-accounts groups → accounts), balance
// snapshot, budget vs actual (budget cells are typed straight into the table).

export function PnlTab({ data, narrow, who, showToast }) {
  const { transactions, accounts, openItems, bas, settings, today, monthOpts, budgets, patch } = data;
  const [span, setSpan] = useState(narrow ? 3 : 6);
  const [view, setView] = useState('pnl');
  const [openGroups, setOpenGroups] = useState(() => new Set());
  const months = useMemo(() => monthOpts.slice(0, span).map((m) => m.value).reverse(), [monthOpts, span]);
  const liveTx = transactions;
  const pnl = useMemo(() => pnlByMonth(liveTx, accounts, months), [liveTx, accounts, months]);
  const opening = useMemo(() => rollForwardBalance(settings?.bank_balance, settings?.bank_balance_date, liveTx.filter((t) => t.is_cash), today), [settings, liveTx, today]);
  const bs = useMemo(() => balanceSnapshot({ bank: opening, openItems, bas }), [opening, openItems, bas]);
  const bva = useMemo(() => budgetVsActual(pnl, budgets), [pnl, budgets]);
  const [draft, setDraft] = useState({});

  const toggle = (g) => setOpenGroups((s) => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n; });
  const saveBudget = async (group, ym) => {
    const key = `${group}|${ym}`;
    if (!(key in draft)) return;
    const v = draft[key];
    const month = `${ym}-01`;
    if (v === '' || v === null) {
      await supabase.from('books_budgets').delete().eq('account_group', group).eq('month', month);
    } else {
      const { error } = await supabase.from('books_budgets').upsert([{ account_group: group, month, amount: Number(v), updated_by: who || null, updated_at: new Date().toISOString() }], { onConflict: 'account_group,month' });
      if (error) { showToast?.(error.message, 'error'); return; }
    }
    const { data: fresh } = await supabase.from('books_budgets').select('account_group, month, amount');
    patch({ budgets: fresh || budgets });
    setDraft((d) => { const n = { ...d }; delete n[key]; return n; });
  };

  const colW = narrow ? 92 : 110;
  const cell = (v, bold) => <td style={{ padding: '7px 10px', textAlign: 'right', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}><Num v={v} signed bold={bold} size={12} /></td>;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: narrow ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
        <Stat label="Income" value={fmtMoney(pnl.income)} tone="in" hint={`${months.length} months`} />
        <Stat label="Costs" value={fmtMoney(pnl.costs)} tone="out" />
        <Stat label="Net" value={fmtMoney(pnl.net_total)} tone={pnl.net_total < 0 ? 'out' : undefined} hint={`${pnl.margin_pct.toFixed(1)}% of income`} />
        <Stat label="Working capital" value={bs.working_capital === null ? '—' : fmtMoney(bs.working_capital)} hint={bs.working_capital === null ? 'type a bank balance on Cash flow' : 'bank + AR − AP − GST'} />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Seg options={[['pnl', 'P&L'], ['budget', 'Budget vs actual'], ['balance', 'Balance']]} value={view} onChange={setView} />
        <select value={span} onChange={(e) => setSpan(Number(e.target.value))} style={{ ...inputStyle, width: 120, minHeight: 36, padding: '6px 9px' }} aria-label="Months">
          {[3, 6, 12].map((n) => <option key={n} value={n}>{n} months</option>)}
        </select>
        <span style={{ marginLeft: 'auto' }}><CsvButton rows={pnlCSVRows(pnl)} filename={`pnl-${months[0]}-${months[months.length - 1]}.csv`} /></span>
      </div>

      {view === 'pnl' && (
        <Card title="Profit & loss · cash basis · ex GST">
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 12, color: C.text, minWidth: 220 + months.length * colW }}>
              <thead><tr>
                <th style={{ textAlign: 'left', padding: '7px 10px', color: C.textMuted, fontFamily: MONO, fontSize: 10, letterSpacing: 1, position: 'sticky', left: 0, background: C.card }}>ACCOUNT</th>
                {months.map((m) => <th key={m} style={{ textAlign: 'right', padding: '7px 10px', color: C.textMuted, fontFamily: MONO, fontSize: 10, letterSpacing: 1, minWidth: colW }}>{monthLabel(m).toUpperCase()}</th>)}
                <th style={{ textAlign: 'right', padding: '7px 10px', color: C.textMuted, fontFamily: MONO, fontSize: 10, letterSpacing: 1 }}>TOTAL</th>
              </tr></thead>
              <tbody>
                {pnl.groups.map((G) => (
                  <GroupRows key={G.group} G={G} months={months} open={openGroups.has(G.group)} toggle={() => toggle(G.group)} cell={cell} />
                ))}
                <tr>
                  <td style={{ padding: '9px 10px', fontWeight: 700, position: 'sticky', left: 0, background: C.card, borderTop: `2px solid ${C.borderStrong}` }}>Net</td>
                  {months.map((m) => <td key={m} style={{ padding: '9px 10px', textAlign: 'right', borderTop: `2px solid ${C.borderStrong}` }}><Num v={pnl.net[m]} signed bold size={12} /></td>)}
                  <td style={{ padding: '9px 10px', textAlign: 'right', borderTop: `2px solid ${C.borderStrong}` }}><Num v={pnl.net_total} signed bold size={12} /></td>
                </tr>
              </tbody>
            </table>
          </div>
          {pnl.groups.length === 0 && <div style={{ color: C.textDim, fontSize: 13 }}>No cash lines in these months.</div>}
        </Card>
      )}

      {view === 'budget' && (
        <Card title="Budget vs actual · type a budget, then Save">
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 12, color: C.text, minWidth: 180 + months.length * 150 }}>
              <thead><tr>
                <th style={{ textAlign: 'left', padding: '7px 10px', color: C.textMuted, fontFamily: MONO, fontSize: 10, letterSpacing: 1, position: 'sticky', left: 0, background: C.card }}>GROUP</th>
                {months.map((m) => <th key={m} colSpan={2} style={{ textAlign: 'right', padding: '7px 10px', color: C.textMuted, fontFamily: MONO, fontSize: 10, letterSpacing: 1 }}>{monthLabel(m).toUpperCase()} · BUDGET / ACTUAL</th>)}
              </tr></thead>
              <tbody>
                {bva.map((r) => (
                  <tr key={r.group}>
                    <td style={{ padding: '7px 10px', fontWeight: 600, position: 'sticky', left: 0, background: C.card, borderBottom: `1px solid ${C.border}` }}>{r.label}</td>
                    {months.map((m) => {
                      const c = r.cells[m]; const key = `${r.group}|${m}`;
                      const val = key in draft ? draft[key] : (c.budget ?? '');
                      const over = c.variance !== null && (r.is_cost ? c.variance > 0 : c.variance < 0);
                      return [
                        <td key={`${m}-b`} style={{ padding: '4px 6px', textAlign: 'right', borderBottom: `1px solid ${C.border}` }}>
                          <MiniInput value={val} onChange={(v) => setDraft({ ...draft, [key]: v })} width={90} step="1" ariaLabel={`Budget ${r.label} ${m}`} />
                        </td>,
                        <td key={`${m}-a`} style={{ padding: '4px 10px 4px 2px', textAlign: 'right', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>
                          <Num v={c.actual} size={12} color={over ? '#fca5a5' : c.variance === null ? undefined : '#86efac'} />
                          {key in draft && <button onClick={() => saveBudget(r.group, m)} style={{ marginLeft: 6, background: C.accent, color: '#fff', border: 'none', borderRadius: R.sm, padding: '3px 8px', fontSize: 11, cursor: 'pointer' }}>Save</button>}
                        </td>,
                      ];
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, color: C.textDim, marginTop: 8 }}>Red actual = over budget on a cost / under budget on income. Totals: budget {fmtMoney(bva.reduce((s, r) => s + r.budget_total, 0))} · actual {fmtMoney(bva.reduce((s, r) => s + r.actual_total, 0))}.</div>
        </Card>
      )}

      {view === 'balance' && (
        <Card title="Balance snapshot · today">
          <KV k="Bank" v={bs.bank === null ? <span style={{ color: C.textDim }}>type it on Cash flow</span> : <Num v={bs.bank} bold />} />
          <KV k="Receivables (open sales invoices)" v={<Num v={bs.receivables} />} />
          <KV k="Payables (open bills)" v={<Num v={-bs.payables} signed />} />
          <KV k="GST position (1A − 1B, this quarter)" v={<Num v={-bs.gst_owing} signed />} />
          <KV k="Working capital" v={bs.working_capital === null ? '—' : <Num v={bs.working_capital} signed bold />} hint="bank + AR − AP − GST" />
          <div style={{ fontSize: 11, color: C.textDim, marginTop: 8 }}>Fixed assets, loans and equity are not in the granted Xero scopes — read those in Xero.</div>
        </Card>
      )}
    </div>
  );
}

function GroupRows({ G, months, open, toggle, cell }) {
  return (
    <>
      <tr onClick={toggle} style={{ cursor: 'pointer' }}>
        <td style={{ padding: '7px 10px', fontWeight: 700, position: 'sticky', left: 0, background: C.card, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{open ? '▾' : '▸'} {G.label} <span style={{ color: C.textDim, fontWeight: 400 }}>{G.accounts.length}</span></td>
        {months.map((m) => cell(G.byMonth[m] || 0, true))}
        {cell(G.total, true)}
      </tr>
      {open && G.accounts.map((A) => (
        <tr key={A.code}>
          <td style={{ padding: '6px 10px 6px 24px', color: C.textMuted, position: 'sticky', left: 0, background: C.card, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}><span style={{ fontFamily: MONO, fontSize: 11 }}>{A.code}</span> {A.name}</td>
          {months.map((m) => cell(A.byMonth[m] || 0, false))}
          {cell(A.total, false)}
        </tr>
      ))}
    </>
  );
}
