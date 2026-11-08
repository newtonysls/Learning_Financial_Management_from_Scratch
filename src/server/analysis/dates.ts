function parts(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) throw new Error(`无效日期：${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`无效日期：${value}`);
  }
  return { year, month, day };
}

export function civilDate(value: string): string {
  const { year, month, day } = parts(value);
  return formatParts(year, month, day);
}

export function addDays(value: string, days: number): string {
  const { year, month, day } = parts(value);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return formatParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function addMonths(value: string, months: number): string {
  const { year, month, day } = parts(value);
  const zeroBased = month - 1 + months;
  const targetYear = year + Math.floor(zeroBased / 12);
  const targetMonth = ((zeroBased % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return formatParts(targetYear, targetMonth + 1, Math.min(day, lastDay));
}

export function compareCivil(left: string, right: string): number {
  return civilDate(left).localeCompare(civilDate(right));
}

function formatParts(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}
