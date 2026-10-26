export type StockExchange = "SH" | "SZ";

export interface StockId {
  code: string;
  exchange: StockExchange;
  canonical: string;
}

export interface PricePoint {
  date: string;
  close: number;
}

export interface DrawdownResult {
  rate: number;
  peakDate: string;
  troughDate: string;
  peak: number;
  trough: number;
}

export interface FinancialSnapshot {
  totalAssets: number;
  totalLiabilities: number;
  currentAssets: number;
  inventory: number;
  currentLiabilities: number;
  revenue: number;
  costOfRevenue: number;
  netIncome: number;
  operatingCashFlow: number;
  equity: number;
  interestExpense: number;
  earningsBeforeInterestAndTax: number;
}

export interface FinancialRatios {
  debtToAsset: number | null;
  currentRatio: number | null;
  quickRatio: number | null;
  interestCoverage: number | null;
  grossMargin: number | null;
  netMargin: number | null;
  returnOnEquity: number | null;
  returnOnAssets: number | null;
  cashToProfit: number | null;
}
