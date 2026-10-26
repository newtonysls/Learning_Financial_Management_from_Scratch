import type { StockId, StockExchange } from "../../shared/types";

export function normalizeStockId(raw: string): StockId {
  const input = raw.trim().toUpperCase().replace(/^SH|^SZ/, "");
  const match = input.match(/^(\d{6})(?:\.(SH|SZ))?$/);

  if (!match) {
    throw new Error("请输入有效的 6 位沪深 A 股代码");
  }

  const code = match[1] as string;
  const exchange = (match[2] ??
    (/^[569]/.test(code) ? "SH" : "SZ")) as StockExchange;

  if (
    (exchange === "SH" && !/^[569]/.test(code)) ||
    (exchange === "SZ" && !/^[023]/.test(code))
  ) {
    throw new Error("股票代码与交易所不匹配");
  }

  return { code, exchange, canonical: `${code}.${exchange}` };
}
