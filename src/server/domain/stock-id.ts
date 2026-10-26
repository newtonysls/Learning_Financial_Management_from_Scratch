import type { StockId, StockExchange } from "../../shared/types";

export function normalizeStockId(raw: string): StockId {
  const input = raw.trim().toUpperCase().replace(/^SH|^SZ/, "");
  const match = input.match(/^(\d{6})(?:\.(SH|SZ))?$/);

  if (!match) {
    throw new Error("请输入有效的 6 位沪深 A 股代码");
  }

  const code = match[1] as string;
  const inferredExchange = inferExchange(code);

  if (!inferredExchange) {
    throw new Error("请输入有效的 6 位沪深 A 股代码");
  }

  const explicitExchange = match[2] as StockExchange | undefined;
  if (explicitExchange && explicitExchange !== inferredExchange) {
    throw new Error("股票代码与交易所不匹配");
  }

  const exchange = explicitExchange ?? inferredExchange;
  return { code, exchange, canonical: `${code}.${exchange}` };
}

function inferExchange(code: string): StockExchange | null {
  if (/^(?:600|601|603|605|688|689)/.test(code)) {
    return "SH";
  }

  if (/^(?:000|001|002|003|300|301)/.test(code)) {
    return "SZ";
  }

  return null;
}
