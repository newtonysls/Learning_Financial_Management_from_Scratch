import type {
  CompanyProfile,
  FinancialSnapshot,
  PricePoint,
  StockId,
} from "../../shared/types";
import { safeFetchJson } from "./http";

const QUOTE_HOST = "push2.eastmoney.com";
const HISTORY_HOST = "push2his.eastmoney.com";
const FINANCIAL_HOST = "datacenter-web.eastmoney.com";

interface EastmoneyEnvelope<T> {
  data?: T | null;
  result?: {
    data?: T[] | null;
  } | null;
}

interface QuotePayload {
  f43?: unknown;
  f57?: unknown;
  f58?: unknown;
  f116?: unknown;
  f127?: unknown;
}

interface HistoryPayload {
  klines?: unknown;
}

export async function fetchCompanyProfile(
  stock: StockId,
): Promise<CompanyProfile> {
  const url = buildQuoteUrl(stock);
  const envelope = await safeFetchJson<EastmoneyEnvelope<QuotePayload>>(
    url,
    { allowedHosts: [QUOTE_HOST] },
  );
  if (!envelope.data || typeof envelope.data !== "object") {
    throw new Error("Eastmoney quote response has no data");
  }

  return {
    stock: { ...stock },
    name: toText(envelope.data.f58),
    industry: toText(envelope.data.f127),
    latestPrice: scaleEastmoneyPrice(envelope.data.f43),
    marketCapitalization: toFiniteNumber(envelope.data.f116),
    sourceUrl: url.toString(),
    retrievedAt: new Date().toISOString(),
  };
}

export async function fetchPriceHistory(
  stock: StockId,
  days: number,
): Promise<PricePoint[]> {
  const boundedDays = validateDays(days);
  const url = buildHistoryUrl(stock, boundedDays);
  const envelope = await safeFetchJson<
    EastmoneyEnvelope<HistoryPayload>
  >(url, { allowedHosts: [HISTORY_HOST] });
  const klines = envelope.data?.klines;
  if (!Array.isArray(klines)) {
    throw new Error("Eastmoney history response has no price series");
  }

  return klines.flatMap((entry): PricePoint[] => {
    if (typeof entry !== "string") {
      return [];
    }
    const fields = entry.split(",");
    const date = fields[0];
    const close = toFiniteNumber(fields[2]);
    if (
      !date ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      close === null ||
      close <= 0
    ) {
      return [];
    }
    return [{ date, close }];
  });
}

export async function fetchFinancials(
  stock: StockId,
): Promise<FinancialSnapshot[]> {
  const url = buildFinancialUrl(stock);
  const envelope = await safeFetchJson<
    EastmoneyEnvelope<Record<string, unknown>>
  >(url, {
    allowedHosts: [FINANCIAL_HOST],
    maxResponseBytes: 5 * 1024 * 1024,
  });
  const rows = envelope.result?.data;
  if (!Array.isArray(rows)) {
    throw new Error("Eastmoney financial response has no records");
  }

  const retrievedAt = new Date().toISOString();
  return rows.flatMap((row): FinancialSnapshot[] => {
    const values = {
      totalAssets: pickFinite(row, "TOTAL_ASSETS"),
      totalLiabilities: pickFinite(row, "TOTAL_LIABILITIES"),
      currentAssets: pickFinite(
        row,
        "TOTAL_CURRENT_ASSETS",
        "CURRENT_ASSETS",
      ),
      inventory: pickFinite(row, "INVENTORY"),
      currentLiabilities: pickFinite(
        row,
        "TOTAL_CURRENT_LIAB",
        "CURRENT_LIABILITIES",
      ),
      revenue: pickFinite(
        row,
        "TOTAL_OPERATE_INCOME",
        "OPERATE_INCOME",
      ),
      costOfRevenue: pickFinite(
        row,
        "OPERATE_COST",
        "TOTAL_OPERATE_COST",
      ),
      netIncome: pickFinite(
        row,
        "PARENT_NETPROFIT",
        "NETPROFIT",
      ),
      operatingCashFlow: pickFinite(
        row,
        "NETCASH_OPERATE",
        "NET_CASH_FLOW",
      ),
      equity: pickFinite(
        row,
        "PARENT_EQUITY",
        "TOTAL_EQUITY",
      ),
      interestExpense: pickFinite(row, "INTEREST_EXPENSE"),
      earningsBeforeInterestAndTax: pickFinite(row, "EBIT"),
    };
    if (Object.values(values).some((value) => value === null)) {
      return [];
    }

    const reportDate = normalizeDate(
      row.REPORT_DATE ?? row.REPORTDATE,
    );
    return [
      {
        reportDate: reportDate ?? undefined,
        ...(values as Omit<
          FinancialSnapshot,
          "reportDate" | "sourceUrl" | "retrievedAt"
        >),
        sourceUrl: url.toString(),
        retrievedAt,
      },
    ];
  });
}

function buildQuoteUrl(stock: StockId): URL {
  const url = new URL(`https://${QUOTE_HOST}/api/qt/stock/get`);
  url.search = new URLSearchParams({
    secid: eastmoneySecurityId(stock),
    fields: "f43,f57,f58,f116,f127",
  }).toString();
  return url;
}

function buildHistoryUrl(stock: StockId, days: number): URL {
  const url = new URL(
    `https://${HISTORY_HOST}/api/qt/stock/kline/get`,
  );
  url.search = new URLSearchParams({
    secid: eastmoneySecurityId(stock),
    klt: "101",
    fqt: "1",
    lmt: String(days),
    end: "20500101",
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
  }).toString();
  return url;
}

function buildFinancialUrl(stock: StockId): URL {
  assertStock(stock);
  const url = new URL(
    `https://${FINANCIAL_HOST}/api/data/v1/get`,
  );
  url.search = new URLSearchParams({
    reportName: "RPT_F10_FINANCE_MAINFINADATA",
    columns: "ALL",
    filter: `(SECURITY_CODE="${stock.code}")`,
    pageNumber: "1",
    pageSize: "20",
    sortColumns: "REPORT_DATE",
    sortTypes: "-1",
  }).toString();
  return url;
}

function eastmoneySecurityId(stock: StockId): string {
  assertStock(stock);
  return `${stock.exchange === "SH" ? "1" : "0"}.${stock.code}`;
}

function assertStock(stock: StockId): void {
  if (
    !/^\d{6}$/.test(stock.code) ||
    (stock.exchange !== "SH" && stock.exchange !== "SZ")
  ) {
    throw new Error("invalid stock identifier");
  }
}

function validateDays(days: number): number {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("history days must be a positive integer");
  }
  return Math.min(days, 5_000);
}

function scaleEastmoneyPrice(value: unknown): number | null {
  const price = toFiniteNumber(value);
  return price === null || price < 0 ? null : price / 100;
}

function toFiniteNumber(value: unknown): number | null {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    value === ""
  ) {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function pickFinite(
  row: Record<string, unknown>,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const value = toFiniteNumber(row[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function toText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text && text !== "-" ? text : null;
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}
