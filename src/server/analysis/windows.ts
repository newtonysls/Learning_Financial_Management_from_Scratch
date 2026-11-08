import type { DrawdownResult, PeriodDrawdown, PricePoint } from "../../shared/types";
import { calculateMaxDrawdown } from "./metrics";
import { addDays, addMonths, compareCivil } from "./dates";

const WINDOWS = [
  { period: "week", label: "周", shift: (asOf: string) => addDays(asOf, -6) },
  { period: "month", label: "月", shift: (asOf: string) => addMonths(asOf, -1) },
  { period: "quarter", label: "季", shift: (asOf: string) => addMonths(asOf, -3) },
  { period: "year", label: "年", shift: (asOf: string) => addMonths(asOf, -12) },
] as const;

export function periodDrawdowns(points: PricePoint[], evidenceId: string | null): PeriodDrawdown[] {
  const ordered = [...points].sort((left, right) => compareCivil(left.date, right.date));
  const latest = ordered.at(-1);
  const earliest = ordered[0];
  return WINDOWS.map((window) => {
    if (!latest || !earliest) {
      return { period: window.period, label: window.label, start: "", complete: false, result: null, evidenceId };
    }
    const start = window.shift(latest.date);
    const complete = compareCivil(earliest.date, start) <= 0;
    const slice = ordered.filter((point) => compareCivil(point.date, start) >= 0);
    let result: DrawdownResult | null = null;
    if (complete && slice.length >= 2) result = calculateMaxDrawdown(slice);
    return { period: window.period, label: window.label, start, complete: result !== null, result, evidenceId };
  });
}
