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

export type SourceGrade = "A" | "B" | "C" | "D";
export type Sentiment = "positive" | "negative" | "neutral";
export type ProfitBasis = "年度" | "累计未年化";

export interface EvidenceRecord {
  id: string;
  source: string;
  sourceGrade: SourceGrade;
  title: string;
  url: string | null;
  publisher: string | null;
  publishedAt: string | null;
  retrievedAt: string;
  reportPeriod: string | null;
  summary: string;
  contentHash: string;
  locator: string | null;
  category: string | null;
  sentiment: Sentiment | null;
}

export type EvidenceDraft = Omit<EvidenceRecord, "id">;

export interface QuoteSnapshot {
  name: string;
  price: number;
  previousClose: number;
  marketCap: number | null;
  pe: number | null;
  pb: number | null;
  industry: string | null;
  evidenceId: string;
}

export interface CompanyProfile {
  name: string;
  shortName: string | null;
  industry: string | null;
  region: string | null;
  website: string | null;
  introduction: string | null;
  businessScope: string | null;
  employees: number | null;
  registeredCapital: string | null;
  chairman: string | null;
  generalManager: string | null;
  independentDirectors: string | null;
  evidenceId: string;
}

export interface ReportedFinancials {
  reportDate: string;
  reportType: string;
  profitBasis: ProfitBasis;
  figures: FinancialSnapshot;
  evidenceIds: string[];
  notes: string[];
}

export interface RatioView extends FinancialRatios {
  reportDate: string;
  reportType: string;
  profitBasis: ProfitBasis;
  evidenceIds: string[];
  revenueYoY: number | null;
}

export interface HolderPosition {
  name: string;
  shares: number | null;
  ratioPercent: number | null;
  holderType: string | null;
  reportDate: string;
  evidenceId: string;
}

export interface PeriodDrawdown {
  period: "week" | "month" | "quarter" | "year";
  label: string;
  start: string;
  complete: boolean;
  result: DrawdownResult | null;
  evidenceId: string | null;
}

export interface TrendSnapshot {
  lastDate: string | null;
  lastClose: number | null;
  ma20: number | null;
  ma60: number | null;
  annualizedVolatility: number | null;
  adjustment: "前复权";
  evidenceId: string | null;
}

export interface RiskItem {
  name: string;
  impact: number | null;
  probability: number | null;
  rationale: string;
  evidenceIds: string[];
}

export interface SourceFailure {
  source: string;
  message: string;
}

export interface ChartBundle {
  financials: {
    periods: string[];
    revenue: number[];
    netIncome: number[];
    operatingCashFlow: Array<number | null>;
  };
  margins: {
    periods: string[];
    gross: Array<number | null>;
    net: Array<number | null>;
    roe: Array<number | null>;
    debt: Array<number | null>;
  };
  capital: { assets: number; liabilities: number; equity: number } | null;
  prices: { dates: string[]; closes: number[] };
  drawdowns: { labels: string[]; rates: Array<number | null> };
  sentiment: { positive: number; negative: number; neutral: number };
  holders: { name: string; ratioPercent: number }[];
  risks: { name: string; impact: number; probability: number }[];
}

export interface ResearchPackage {
  stock: StockId;
  generatedAt: string;
  profile: CompanyProfile | null;
  quote: QuoteSnapshot | null;
  financials: ReportedFinancials[];
  ratios: RatioView | null;
  prices: PricePoint[];
  drawdowns: PeriodDrawdown[];
  trend: TrendSnapshot;
  holders: HolderPosition[];
  risks: RiskItem[];
  evidence: EvidenceRecord[];
  failures: SourceFailure[];
  charts: ChartBundle;
}

export interface ReportDocument {
  title: string;
  markdown: string;
  citations: string[];
}

export interface AnalysisResult extends ResearchPackage {
  reportMarkdown: string;
  narrativeMode: "deterministic" | "model";
}
