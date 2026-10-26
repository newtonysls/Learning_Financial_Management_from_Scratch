import type {
  CompanyProfile,
  EvidenceRecord,
  FinancialSnapshot,
  PricePoint,
  StockId,
} from "../../shared/types";
import { assertStockId } from "../domain/stock-id";
import { hashContent } from "../evidence/evidence-store";
import { safeFetchJson } from "./http";

const QUOTE_HOST = "push2.eastmoney.com";
const HISTORY_HOST = "push2his.eastmoney.com";
const FINANCIAL_HOST = "datacenter.eastmoney.com";
const FINANCIAL_ENDPOINT = `https://${FINANCIAL_HOST}/securities/api/data/get`;

interface EastmoneyEnvelope<T> {
  success?: boolean;
  message?: string;
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

type FinancialStatement = Record<string, unknown>;

const BALANCE_FIELDS = [
  "SECUCODE",
  "SECURITY_CODE",
  "REPORT_DATE",
  "REPORT_TYPE",
  "CURRENCY",
  "TOTAL_ASSETS",
  "TOTAL_CURRENT_ASSETS",
  "INVENTORY",
  "TOTAL_CURRENT_LIAB",
  "TOTAL_LIABILITIES",
  "TOTAL_PARENT_EQUITY",
] as const;

const INCOME_FIELDS = [
  "SECUCODE",
  "SECURITY_CODE",
  "REPORT_DATE",
  "REPORT_TYPE",
  "CURRENCY",
  "TOTAL_OPERATE_INCOME",
  "OPERATE_COST",
  "PARENT_NETPROFIT",
  "FE_INTEREST_EXPENSE",
  "TOTAL_PROFIT",
] as const;

const CASHFLOW_FIELDS = [
  "SECUCODE",
  "SECURITY_CODE",
  "REPORT_DATE",
  "REPORT_TYPE",
  "CURRENCY",
  "NETCASH_OPERATE",
] as const;

export async function fetchCompanyProfile(
  stock: StockId,
): Promise<CompanyProfile> {
  const normalizedStock = assertStockId(stock);
  const url = buildQuoteUrl(normalizedStock);
  const envelope = await safeFetchJson<EastmoneyEnvelope<QuotePayload>>(
    url,
    { allowedHosts: [QUOTE_HOST] },
  );
  if (!envelope.data || typeof envelope.data !== "object") {
    throw new Error("Eastmoney quote response has no data");
  }

  const retrievedAt = new Date().toISOString();
  const normalizedProfile = {
    stock: { ...normalizedStock },
    name: toText(envelope.data.f58),
    industry: toText(envelope.data.f127),
    latestPrice: scaleEastmoneyPrice(envelope.data.f43),
    marketCapitalization: toFiniteNumber(envelope.data.f116),
    sourceUrl: url.toString(),
    retrievedAt,
  };
  const content = JSON.stringify(normalizedProfile);
  return {
    ...normalizedProfile,
    evidence: {
      id: `eastmoney:profile:${normalizedStock.canonical}`,
      sourceGrade: "C",
      title: `${normalizedStock.canonical} 公司概况`,
      content,
      contentType: "text/plain",
      contentHash: hashContent(content),
      sourceUrl: url.toString(),
      retrievedAt,
    },
  };
}

export async function fetchPriceHistory(
  stock: StockId,
  days: number,
): Promise<PricePoint[]> {
  const normalizedStock = assertStockId(stock);
  const boundedDays = validateDays(days);
  const url = buildHistoryUrl(normalizedStock, boundedDays);
  const envelope = await safeFetchJson<
    EastmoneyEnvelope<HistoryPayload>
  >(url, { allowedHosts: [HISTORY_HOST] });
  const klines = envelope.data?.klines;
  if (!Array.isArray(klines)) {
    throw new Error("Eastmoney history response has no price series");
  }

  const normalizedPoints = klines.flatMap((entry): PricePoint[] => {
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
  if (normalizedPoints.length === 0) {
    throw new Error("Eastmoney history response has no usable prices");
  }
  const retrievedAt = new Date().toISOString();
  const content = JSON.stringify(normalizedPoints);
  const evidence: EvidenceRecord = {
    id: `eastmoney:prices:${normalizedStock.canonical}`,
    sourceGrade: "C",
    title: `${normalizedStock.canonical} 历史行情`,
    content,
    contentType: "text/plain",
    contentHash: hashContent(content),
    sourceUrl: url.toString(),
    retrievedAt,
  };
  return normalizedPoints.map((point) => ({ ...point, evidence }));
}

export async function fetchFinancials(
  stock: StockId,
): Promise<FinancialSnapshot[]> {
  const normalizedStock = assertStockId(stock);
  const urls = {
    balance: buildFinancialUrl(
      normalizedStock,
      "RPT_F10_FINANCE_GBALANCE",
      "F10_FINANCE_GBALANCE",
    ),
    income: buildFinancialUrl(
      normalizedStock,
      "RPT_F10_FINANCE_GINCOME",
      "APP_F10_GINCOME",
    ),
    cashflow: buildFinancialUrl(
      normalizedStock,
      "RPT_F10_FINANCE_GCASHFLOW",
      "APP_F10_GCASHFLOW",
    ),
  };
  const [balanceResponse, incomeResponse, cashflowResponse] =
    await Promise.all([
      fetchFinancialStatement(urls.balance),
      fetchFinancialStatement(urls.income),
      fetchFinancialStatement(urls.cashflow),
    ]);
  const balances = validatedStatementRows(
    balanceResponse,
    "balance",
    BALANCE_FIELDS,
    normalizedStock,
  );
  const incomes = validatedStatementRows(
    incomeResponse,
    "income",
    INCOME_FIELDS,
    normalizedStock,
  );
  const cashflows = validatedStatementRows(
    cashflowResponse,
    "cashflow",
    CASHFLOW_FIELDS,
    normalizedStock,
  );
  const incomeByPeriod = indexStatements(incomes);
  const cashflowByPeriod = indexStatements(cashflows);
  const retrievedAt = new Date().toISOString();
  const sourceUrls = Object.values(urls).map((url) => url.toString());
  const snapshots = balances.flatMap(
    (balance): FinancialSnapshot[] => {
      const key = statementKey(balance);
      const income = incomeByPeriod.get(key);
      const cashflow = cashflowByPeriod.get(key);
      if (!income || !cashflow) {
        return [];
      }
      const reportDate = normalizeDate(balance.REPORT_DATE);
      const reportType = toText(balance.REPORT_TYPE);
      const currency = toText(balance.CURRENCY);
      if (!reportDate || !reportType || !currency) {
        throw new Error(
          "Eastmoney financial source contract has invalid period metadata",
        );
      }
      const interestExpense = requireFinite(
        income,
        "FE_INTEREST_EXPENSE",
      );
      const snapshotBase = {
        reportDate,
        reportType,
        periodScope:
          reportType === "年报"
            ? ("annual" as const)
            : ("year-to-date" as const),
        annualized: false as const,
        currency,
        totalAssets: requireFinite(balance, "TOTAL_ASSETS"),
        totalLiabilities: requireFinite(
          balance,
          "TOTAL_LIABILITIES",
        ),
        currentAssets: requireFinite(
          balance,
          "TOTAL_CURRENT_ASSETS",
        ),
        inventory: requireFinite(balance, "INVENTORY"),
        currentLiabilities: requireFinite(
          balance,
          "TOTAL_CURRENT_LIAB",
        ),
        revenue: requireFinite(income, "TOTAL_OPERATE_INCOME"),
        costOfRevenue: requireFinite(income, "OPERATE_COST"),
        netIncome: requireFinite(income, "PARENT_NETPROFIT"),
        operatingCashFlow: requireFinite(
          cashflow,
          "NETCASH_OPERATE",
        ),
        equity: requireFinite(balance, "TOTAL_PARENT_EQUITY"),
        interestExpense,
        earningsBeforeInterestAndTax:
          requireFinite(income, "TOTAL_PROFIT") + interestExpense,
        interestExpenseBasis:
          "FE_INTEREST_EXPENSE" as const,
        sourceUrl: urls.balance.toString(),
        retrievedAt,
      };
      const content = JSON.stringify({
        ...snapshotBase,
        sourceUrls,
        accountingBasis: {
          revenue: "TOTAL_OPERATE_INCOME",
          costOfRevenue: "OPERATE_COST",
          netIncome: "PARENT_NETPROFIT",
          operatingCashFlow: "NETCASH_OPERATE",
          equity: "TOTAL_PARENT_EQUITY",
          ebit:
            "TOTAL_PROFIT + FE_INTEREST_EXPENSE",
        },
      });
      const evidence: EvidenceRecord = {
        id: `eastmoney:financial:${normalizedStock.canonical}:${reportDate}`,
        sourceGrade: "C",
        title: `${normalizedStock.canonical} ${reportDate} 财务报表`,
        content,
        contentType: "text/plain",
        contentHash: hashContent(content),
        sourceUrl: urls.balance.toString(),
        sourceUrls,
        retrievedAt,
      };
      return [{ ...snapshotBase, evidence }];
    },
  );
  if (snapshots.length === 0) {
    throw new Error(
      "Eastmoney financial source contract has no joinable complete periods",
    );
  }
  return snapshots.sort((left, right) =>
    (right.reportDate ?? "").localeCompare(left.reportDate ?? ""),
  );
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

function buildFinancialUrl(
  stock: StockId,
  reportName: string,
  style: string,
): URL {
  const url = new URL(FINANCIAL_ENDPOINT);
  url.search = new URLSearchParams({
    type: reportName,
    sty: style,
    filter: `(SECUCODE="${stock.canonical}")`,
    p: "1",
    ps: "20",
    sr: "-1",
    st: "REPORT_DATE",
    source: "HSF10",
    client: "PC",
    v: "05767841728614413",
  }).toString();
  return url;
}

function eastmoneySecurityId(stock: StockId): string {
  return `${stock.exchange === "SH" ? "1" : "0"}.${stock.code}`;
}

async function fetchFinancialStatement(
  url: URL,
): Promise<EastmoneyEnvelope<FinancialStatement>> {
  return safeFetchJson<EastmoneyEnvelope<FinancialStatement>>(url, {
    allowedHosts: [FINANCIAL_HOST],
    maxResponseBytes: 5 * 1024 * 1024,
    request: {
      headers: {
        referer: "https://quote.eastmoney.com/",
      },
    },
  });
}

function validatedStatementRows(
  response: EastmoneyEnvelope<FinancialStatement>,
  statementName: string,
  requiredFields: readonly string[],
  stock: StockId,
): FinancialStatement[] {
  const rows = response.result?.data;
  if (
    response.success === false ||
    !Array.isArray(rows) ||
    rows.length === 0
  ) {
    throw new Error(
      `Eastmoney ${statementName} source returned no records`,
    );
  }
  const matchingRows = rows.filter(
    (row) =>
      isRecord(row) &&
      row.SECUCODE === stock.canonical &&
      row.SECURITY_CODE === stock.code,
  );
  if (matchingRows.length === 0) {
    throw new Error(
      `Eastmoney ${statementName} source returned no matching stock records`,
    );
  }
  for (const row of matchingRows) {
    if (!requiredFields.every((field) => Object.hasOwn(row, field))) {
      throw new Error(
        `Eastmoney ${statementName} source contract changed`,
      );
    }
    statementKey(row);
  }
  return matchingRows;
}

function indexStatements(
  rows: FinancialStatement[],
): Map<string, FinancialStatement> {
  return new Map(rows.map((row) => [statementKey(row), row]));
}

function statementKey(row: FinancialStatement): string {
  const reportDate = normalizeDate(row.REPORT_DATE);
  const reportType = toText(row.REPORT_TYPE);
  if (!reportDate || !reportType) {
    throw new Error(
      "Eastmoney financial source contract has invalid report period",
    );
  }
  return `${reportDate}:${reportType}`;
}

function requireFinite(
  row: FinancialStatement,
  field: string,
): number {
  const value = toFiniteNumber(row[field]);
  if (value === null) {
    throw new Error(
      `Eastmoney financial source has unavailable required field: ${field}`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is FinancialStatement {
  return typeof value === "object" && value !== null;
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
