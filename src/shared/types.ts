export type StockExchange = "SH" | "SZ";

export interface StockId {
  code: string;
  exchange: StockExchange;
  canonical: string;
}

export interface PricePoint {
  date: string;
  close: number;
  evidence?: EvidenceRecord;
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
  reportType?: string;
  periodScope?: "annual" | "year-to-date";
  annualized?: false;
  currency?: string;
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
  interestExpenseBasis?: "FE_INTEREST_EXPENSE";
  sourceUrl?: string;
  retrievedAt?: string;
  evidence?: EvidenceRecord;
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
  evidence?: EvidenceRecord;
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
  sourceUrls?: string[];
  publishedAt?: string;
  retrievedAt: string;
  category?: string;
  content?: string;
  contentType?: "text/plain";
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

export interface DrawdownAnalysis {
  result: DrawdownResult;
  evidenceIds: string[];
  retrievedAt: string;
  periodStart: string;
  periodEnd: string;
  coverage: "full";
}

export interface PeriodDrawdowns {
  weekly: DrawdownAnalysis | null;
  monthly: DrawdownAnalysis | null;
  quarterly: DrawdownAnalysis | null;
  yearly: DrawdownAnalysis | null;
}

export interface RatioAnalysis {
  values: FinancialRatios;
  evidenceIds: string[];
  retrievedAt: string;
  reportDate: string;
  reportType: string;
  periodScope: "annual" | "year-to-date";
  annualized: false;
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
  knowledgeBaseRoot?: string;
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
  ratios: RatioAnalysis | null;
  drawdowns: PeriodDrawdowns;
  failures: ResearchFailure[];
  generatedAt: string;
}
