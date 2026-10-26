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
  reportDate?: string;
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
  sourceUrl?: string;
  retrievedAt?: string;
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

export interface CompanyProfile {
  stock: StockId;
  name: string | null;
  industry: string | null;
  latestPrice: number | null;
  marketCapitalization: number | null;
  sourceUrl: string;
  retrievedAt: string;
}

export type SourceGrade = "A" | "B" | "C" | "D";

export interface EvidenceLocator {
  page?: number;
  sheet?: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface EvidenceRecord {
  id: string;
  sourceGrade: SourceGrade;
  title: string;
  contentHash: string;
  sourceUrl?: string;
  publishedAt?: string;
  retrievedAt: string;
  category?: string;
  content?: string;
  locator?: EvidenceLocator;
}

export interface ResearchFailure {
  source:
    | "companyProfile"
    | "priceHistory"
    | "financials"
    | "announcements"
    | "localDocument";
  message: string;
  path?: string;
}

export interface PeriodDrawdowns {
  weekly: DrawdownResult | null;
  monthly: DrawdownResult | null;
  quarterly: DrawdownResult | null;
  yearly: DrawdownResult | null;
}

export interface ResearchSources {
  fetchCompanyProfile(stock: StockId): Promise<CompanyProfile>;
  fetchPriceHistory(
    stock: StockId,
    days: number,
  ): Promise<PricePoint[]>;
  fetchFinancials(stock: StockId): Promise<FinancialSnapshot[]>;
  fetchAnnouncements(stock: StockId): Promise<EvidenceRecord[]>;
}

export interface BuildResearchInput {
  stock: StockId;
  historyDays?: number;
  localDocumentPaths?: string[];
  sources?: ResearchSources;
  now?: () => string;
}

export interface ResearchPackage {
  stock: StockId;
  profile: CompanyProfile | null;
  priceHistory: PricePoint[];
  financials: FinancialSnapshot[];
  announcements: EvidenceRecord[];
  evidence: EvidenceRecord[];
  ratios: FinancialRatios | null;
  drawdowns: PeriodDrawdowns;
  failures: ResearchFailure[];
  generatedAt: string;
}
