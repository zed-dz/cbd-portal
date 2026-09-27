// Run: node --experimental-strip-types hoursCalc.test.ts   (Node 22+)
// or:  npx vitest (rename to .spec.ts)
import { calcShift } from "./hoursCalc.ts";

type Case = [string, Parameters<typeof calcShift>[0], "A" | "B" | "C", [number, number, number, number]];

const cases: Case[] = [
  // name, input, variant, [total, regular, 1.5x, 2.0x]
  ["Weekday day 07:00-15:30, 0.5 break", { date: "2026-09-22", shiftType: "Day Shift", dayType: "Regular Work", start: "07:00", end: "15:30", breakHours: 0.5 }, "B", [8, 8, 0, 0]],
  ["Weekday day 06:00-18:00, 0.5 break", { date: "2026-09-22", shiftType: "Day Shift", dayType: "Regular Work", start: "06:00", end: "18:00", breakHours: 0.5 }, "B", [11.5, 8, 2, 1.5]],
  ["REAL FORM: Sat day 07:00-12:00, no break", { date: "2026-09-26", shiftType: "Day Shift", dayType: "Regular Work", start: "07:00", end: "12:00", breakHours: 0 }, "B", [5, 0, 2, 3]],
  ["Sunday day 07:00-15:00, 0.5 break", { date: "2026-09-27", shiftType: "Day Shift", dayType: "Regular Work", start: "07:00", end: "15:00", breakHours: 0.5 }, "B", [7.5, 0, 0, 7.5]],
  ["Weekday night 18:00-04:00, 0.5 break", { date: "2026-09-22", shiftType: "Night Shift", dayType: "Regular Work", start: "18:00", end: "04:00", breakHours: 0.5 }, "B", [9.5, 0, 8, 1.5]],
  ["Day shift starting 18:00 is blocked", { date: "2026-09-22", shiftType: "Day Shift", dayType: "Regular Work", start: "18:00", end: "23:00", breakHours: 0 }, "B", [0, 0, 0, 0]],
  ["Public Holiday weekday day", { date: "2026-09-22", shiftType: "Day Shift", dayType: "Public Holiday", start: "07:00", end: "15:00", breakHours: 0 }, "B", [8, 8, 0, 0]],
  ["Weekday early 04:00-14:00, 0.5 break", { date: "2026-09-22", shiftType: "Day Shift", dayType: "Regular Work", start: "04:00", end: "14:00", breakHours: 0.5 }, "B", [9.5, 8, 1.5, 0]],
  ["Variant A weekday day 06:30-17:00, 0.5", { date: "2026-09-23", shiftType: "Day Shift", start: "06:30", end: "17:00", breakHours: 0.5 }, "A", [10, 8, 2, 0]],
  ["Variant C night starting 01:00-07:00", { date: "2026-09-23", shiftType: "Night Shift", dayType: "Regular Work", start: "01:00", end: "07:00", breakHours: 0 }, "C", [6, 0, 6, 0]],
  ["Saturday night 18:00-02:00 all 2.0x", { date: "2026-09-26", shiftType: "Night Shift", dayType: "Regular Work", start: "18:00", end: "02:00", breakHours: 0 }, "B", [8, 0, 0, 8]],
];

let fail = 0;
for (const [name, input, v, [t, r, o15, o20]] of cases) {
  const res = calcShift(input, v);
  const ok = res.total === t && res.regular === r && res.ot15 === o15 && res.ot20 === o20;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  -> total ${res.total}, reg ${res.regular}, 1.5x ${res.ot15}, 2.0x ${res.ot20}${ok ? "" : `  (expected ${t}/${r}/${o15}/${o20})`}`);
}
const meal = calcShift({ date: "2026-09-22", shiftType: "Day Shift", dayType: "Regular Work", start: "06:00", end: "16:00", breakHours: 0.5 }, "B");
console.log(meal.mealAllowance === 1 ? "PASS  meal allowance at 9.5 h" : "FAIL  meal allowance"); if (meal.mealAllowance !== 1) fail++;
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
