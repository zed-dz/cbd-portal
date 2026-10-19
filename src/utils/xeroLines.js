// Xero Payroll AU earnings-line split — pure functions, no React, no Supabase.
//
// ONE source of truth for "which Xero pay item carries which hours". The
// xero-push edge function (Deno, single-file deploy) carries a line-for-line
// TypeScript copy of this file; keep both in step and run xeroLines.test.js.
//
// Inputs
//   totals        { ordinary, ot15, ot2x, unsplit }   hours summed per employee
//   worker        { worker_type, pay_rate_regular, pay_rate_base, casual_loading_pct }
//   earningsRates Xero /PayItems → EarningsRates[] ({ EarningsRateID, Name, EarningsType, RateType, Multiplier })
//   templateLines the payslip's existing EarningsLines (Xero fills them from the
//                 employee's pay template; line 0 is the ordinary line by convention)
// Output
//   { lines, summary: { ordinary, ot15, ot2, loading, pay_items_used, warnings } }

const num = (v) => { const n = parseFloat(v ?? 0); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round(n * 100) / 100;
const nameOf = (r) => String(r?.Name || '');

// Overtime rate lookup, in the order the owner asked for:
//   1.5× → EarningsType OVERTIMEEARNINGS with Multiplier 1.5, else a name
//          containing "Overtime" AND "1.5" (or "time and a half"), else any
//          rate named "Overtime".
//   2×   → Multiplier 2, else a name containing "Overtime" AND ("2" or "Double").
export function findOvertimeRate(earningsRates, mult) {
  const rates = earningsRates || [];
  const ot = rates.filter(r => String(r.EarningsType || '').toUpperCase() === 'OVERTIMEEARNINGS');
  const pool = ot.length ? ot : rates.filter(r => /overtime/i.test(nameOf(r)));
  const byMult = pool.find(r => Number(r.Multiplier) === mult);
  if (byMult) return byMult;
  if (mult === 1.5) {
    return pool.find(r => /overtime/i.test(nameOf(r)) && (/1\.5/.test(nameOf(r)) || /time\s*and\s*a\s*half/i.test(nameOf(r))))
      || pool.find(r => /overtime/i.test(nameOf(r)) && !/\b2(\.0)?\s*x?\b|double/i.test(nameOf(r)))
      || pool.find(r => /overtime/i.test(nameOf(r)))
      || null;
  }
  return pool.find(r => /overtime/i.test(nameOf(r)) && (/\b2(\.0)?\s*x?\b/i.test(nameOf(r)) || /double/i.test(nameOf(r))))
    || null;
}

// "Casual Loading" pay item: any earnings rate whose name says so.
export function findCasualLoadingRate(earningsRates) {
  return (earningsRates || []).find(r => /casual\s*loading/i.test(nameOf(r))) || null;
}

// The ordinary line: the template line whose rate is ORDINARYTIMEEARNINGS,
// else the first line (what the push has always done).
export function findOrdinaryLineIndex(templateLines, earningsRates) {
  const lines = templateLines || [];
  const ordIds = new Set((earningsRates || [])
    .filter(r => String(r.EarningsType || '').toUpperCase() === 'ORDINARYTIMEEARNINGS')
    .map(r => r.EarningsRateID));
  const i = lines.findIndex(l => ordIds.has(l.EarningsRateID));
  return i >= 0 ? i : (lines.length ? 0 : -1);
}

// Casual loading applies when the worker is casual AND carries a base rate +
// a loading percentage (stored as a fraction, 0.25; a whole number like 25 is
// tolerated and read as a percent).
export function casualLoadingFor(worker) {
  if (!worker || worker.worker_type !== 'casual') return null;
  const base = num(worker.pay_rate_base);
  let pct = num(worker.casual_loading_pct);
  if (pct > 1) pct = pct / 100;
  if (base <= 0 || pct <= 0) return null;
  return { base, pct };
}

export function buildEmployeeLines({ totals, worker, earningsRates, templateLines }) {
  const t = {
    ordinary: num(totals?.ordinary), ot15: num(totals?.ot15),
    ot2x: num(totals?.ot2x), unsplit: num(totals?.unsplit),
  };
  const lines = (templateLines || []).map(l => ({ ...l }));
  const warnings = [];
  const payItemsUsed = [];
  const summary = { ordinary: 0, ot15: 0, ot2: 0, loading: 0, pay_items_used: payItemsUsed, warnings };

  const ordIdx = findOrdinaryLineIndex(lines, earningsRates);
  if (ordIdx < 0) {
    warnings.push('payslip has no earnings lines — add an ordinary earnings rate to the pay template in Xero');
    return { lines, summary, ok: false };
  }
  const ordLine = lines[ordIdx];
  const rateName = (id) => nameOf((earningsRates || []).find(r => r.EarningsRateID === id)) || 'Ordinary';

  let ordinaryUnits = t.ordinary;

  // Overtime buckets → their own lines, or folded into ordinary when Xero has no rate.
  const place = (hours, mult, label, bucket) => {
    if (hours <= 0) return;
    const rate = findOvertimeRate(earningsRates, mult);
    if (!rate) {
      ordinaryUnits += hours;
      warnings.push(`${round2(hours)}h ${label} folded into ordinary time: no ${label} overtime pay item in Xero`);
      return;
    }
    const existing = lines.find(l => l.EarningsRateID === rate.EarningsRateID);
    if (existing) existing.NumberOfUnits = round2(num(existing.NumberOfUnits) + hours);
    else lines.push({ EarningsRateID: rate.EarningsRateID, NumberOfUnits: round2(hours) });
    summary[bucket] = round2(summary[bucket] + hours);
    if (!payItemsUsed.includes(nameOf(rate))) payItemsUsed.push(nameOf(rate));
  };
  // Template OT lines come pre-filled with 0 units; start from 0 for OUR buckets.
  for (const l of lines) { if (l !== ordLine && /overtime/i.test(rateName(l.EarningsRateID))) l.NumberOfUnits = 0; }
  place(t.ot15, 1.5, 'OT 1.5x', 'ot15');
  place(t.ot2x, 2, 'OT 2x', 'ot2');
  if (t.unsplit > 0) place(t.unsplit, 1.5, 'overtime (unsplit, sent as 1.5x)', 'ot15');

  // Casual loading: ordinary hours at the BASE rate + a loading line, when the
  // org has a "Casual Loading" pay item. Otherwise ordinary at rate A and say so.
  const loading = casualLoadingFor(worker);
  if (loading && ordinaryUnits > 0) {
    const lr = findCasualLoadingRate(earningsRates);
    if (lr) {
      ordLine.NumberOfUnits = round2(ordinaryUnits);
      ordLine.RatePerUnit = round2(loading.base);
      const loadLine = { EarningsRateID: lr.EarningsRateID, NumberOfUnits: round2(ordinaryUnits) };
      // A RATEPERUNIT item needs the $/h we want; a MULTIPLE item takes its
      // multiplier from Xero and ignores RatePerUnit.
      if (String(lr.RateType || 'RATEPERUNIT').toUpperCase() === 'RATEPERUNIT') {
        loadLine.RatePerUnit = round2(loading.base * loading.pct);
      }
      const existing = lines.find(l => l.EarningsRateID === lr.EarningsRateID);
      if (existing) Object.assign(existing, loadLine); else lines.push(loadLine);
      summary.loading = round2(ordinaryUnits);
      payItemsUsed.push(nameOf(lr));
    } else {
      ordLine.NumberOfUnits = round2(ordinaryUnits);
      if (num(worker.pay_rate_regular) > 0) ordLine.RatePerUnit = round2(num(worker.pay_rate_regular));
      warnings.push(`no "Casual Loading" pay item in Xero — ${round2(ordinaryUnits)}h ordinary sent at the loaded rate A ($${round2(num(worker.pay_rate_regular)).toFixed(2)}/h)`);
    }
  } else {
    ordLine.NumberOfUnits = round2(ordinaryUnits);
  }
  summary.ordinary = round2(ordinaryUnits);
  payItemsUsed.unshift(rateName(ordLine.EarningsRateID));

  return { lines, summary, ok: true };
}
