import { useMemo, useState } from 'react';
import { C, R, MONO, btnSmall } from '../../theme';
import { Badge, EmptyState } from '../index';
import { Num, CsvButton, Stat } from './BooksBits';
import { exceptionsV2, exceptionsCSVRows, V2_FLAG_LABEL, V2_FLAG_COLOR } from '../../utils/booksExceptions';
import { isOurs } from '../../utils/books';
import { fmtDate } from '../../utils/dates';

// v1 flags come from SQL (books_exceptions); v2 flags are computed here over
// the same synced rows. One list, filter chips per flag, CSV.

const FLAG_LABEL = { duplicate: 'Duplicate', uncoded: 'Uncoded spend', large: 'Large claim', overdue_bill: 'Bill overdue', ...V2_FLAG_LABEL };
const FLAG_COLOR = { duplicate: 'orange', uncoded: 'yellow', large: 'red', overdue_bill: 'red', ...V2_FLAG_COLOR };

export function ExceptionsTab({ data, narrow, lastOk }) {
  const { sqlExceptions, transactions, invoices, tsLite, today, ourNumbers, settings } = data;
  const v2 = useMemo(() => exceptionsV2({ transactions, invoices, timesheets: (tsLite || []).filter((t) => String(t.status).toLowerCase() === 'approved'), today }), [transactions, invoices, tsLite, today]);
  const all = useMemo(() => [...sqlExceptions, ...v2], [sqlExceptions, v2]);
  const counts = useMemo(() => all.reduce((a, e) => { a[e.flag] = (a[e.flag] || 0) + 1; return a; }, {}), [all]);
  const [flag, setFlag] = useState('');
  const list = flag ? all.filter((e) => e.flag === flag) : all;
  const openInvoices = () => window.dispatchEvent(new CustomEvent('cbd:navigate', { detail: { page: 'invoices' } }));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: narrow ? 'repeat(2, minmax(0, 1fr))' : 'repeat(5, minmax(0, 1fr))', gap: 8 }}>
        <Stat label="Flags" value={String(all.length)} />
        <Stat label="Duplicates" value={String(counts.duplicate || 0)} tone={counts.duplicate ? 'out' : undefined} />
        <Stat label="Uncoded" value={String(counts.uncoded || 0)} />
        <Stat label="Large claims" value={String(counts.large || 0)} hint={settings ? `over $${Number(settings.large_claim_threshold).toLocaleString('en-AU')}` : undefined} />
        <Stat label="Spend spikes" value={String(counts.spend_spike || 0)} tone={counts.spend_spike ? 'out' : undefined} />
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => setFlag('')} style={{ ...btnSmall, minHeight: 32, background: !flag ? C.accentSoft : btnSmall.background, color: !flag ? '#fdba74' : C.text }}>All {all.length}</button>
        {Object.keys(FLAG_LABEL).filter((f) => counts[f]).map((f) => (
          <button key={f} onClick={() => setFlag(flag === f ? '' : f)} style={{ ...btnSmall, minHeight: 32, background: flag === f ? C.accentSoft : btnSmall.background, color: flag === f ? '#fdba74' : C.text }}>{FLAG_LABEL[f]} <span style={{ fontFamily: MONO, color: C.textMuted }}>{counts[f]}</span></button>
        ))}
        <span style={{ marginLeft: 'auto' }}><CsvButton rows={exceptionsCSVRows(list)} filename={`exceptions-${today}.csv`} /></span>
      </div>
      {list.length === 0 ? <EmptyState icon="✅" message={lastOk ? 'No exceptions in the synced data.' : 'Nothing synced yet — press Sync now.'} /> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {list.map((e, i) => {
            const ours = isOurs(e.number, ourNumbers);
            return (
              <div key={`${e.flag}-${e.xero_id}-${i}`} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: R.md, padding: '10px 12px', display: 'grid', gap: 6, gridTemplateColumns: narrow ? '1fr' : '1fr auto', alignItems: 'center' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Badge label={FLAG_LABEL[e.flag] || e.flag} color={FLAG_COLOR[e.flag] || 'gray'} size="sm" />
                    <span style={{ color: C.text, fontWeight: 600, fontSize: 13, overflowWrap: 'anywhere' }}>{e.contact_name || '(no contact)'}</span>
                    {e.number && <span style={{ fontFamily: MONO, fontSize: 11, color: C.textMuted }}>{e.number}</span>}
                    {ours && <Badge label="ours" color="blue" size="sm" />}
                  </div>
                  <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, lineHeight: 1.45 }}>{e.reason}</div>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: narrow ? 'space-between' : 'flex-end', flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: MONO, fontSize: 12, color: C.textMuted }}>{fmtDate(e.txn_date)}</span>
                  <Num v={e.amount} bold size={14} />
                  {(ours || e.flag === 'invoice_no_hours') && <button onClick={openInvoices} style={btnSmall}>Invoices →</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
