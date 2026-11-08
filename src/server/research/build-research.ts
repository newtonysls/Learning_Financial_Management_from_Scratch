import { calculateFinancialRatios } from "../analysis/metrics";
import { assessRisks } from "../analysis/risk";
import { compareCivil } from "../analysis/dates";
import { redactSecrets } from "../analysis/text";
import { periodDrawdowns } from "../analysis/windows";
import { parseLocalDocument } from "../documents/parser";
import { EvidenceStore } from "../evidence/evidence-store";
import { fetchAnnouncements } from "../sources/cninfo";
import {
  fetchComments,
  fetchFinancials,
  fetchHolders,
  fetchNews,
  fetchPriceHistory,
  fetchProfile,
  fetchQuote,
} from "../sources/eastmoney";
import type { SafeClient } from "../sources/http";
import { fetchBaike, fetchOfficialSite } from "../sources/pages";
import { normalizeStockId } from "../domain/stock-id";
import type {
  ChartBundle,
  CompanyProfile,
  FinancialRatios,
  HolderPosition,
  PeriodDrawdown,
  PricePoint,
  QuoteSnapshot,
  RatioView,
  ReportedFinancials,
  ResearchPackage,
  SourceFailure,
  TrendSnapshot,
} from "../../shared/types";

export interface ResearchInput {
  stockCode: string;
  documentPaths?: string[];
  knowledgeRoot?: string;
  now?: Date;
  client?: SafeClient;
}

const POLICY_WORDS = ["政策", "海关", "关税", "出口管制", "制裁", "地缘", "监管", "立案", "处罚"];

export async function buildResearchPackage(
  input: ResearchInput,
  onProgress: (message: string) => void = () => undefined,
): Promise<ResearchPackage> {
  const stock = normalizeStockId(input.stockCode);
  const retrievedAt = (input.now ?? new Date()).toISOString();
  const store = new EvidenceStore();
  const failures: SourceFailure[] = [];
  const context = { client: input.client, store, retrievedAt };
  onProgress("已识别沪深 A 股代码");

  const [quote, history, financials, profile, holders] = await Promise.all([
    settle("东方财富行情", () => fetchQuote(stock, context), failures),
    settle("东方财富日线", () => fetchPriceHistory(stock, context), failures),
    settle("东方财富财务报表", () => fetchFinancials(stock, context), failures),
    settle("东方财富公司概况", () => fetchProfile(stock, context), failures),
    settle("东方财富股东", () => fetchHolders(stock, context), failures),
    settle("巨潮资讯公告", () => fetchAnnouncements(stock, context), failures),
  ]);
  onProgress("公开行情、财务与公告采集结束");

  const keyword = profile?.shortName || quote?.name || profile?.name || stock.code;
  await Promise.all([
    settle("东方财富新闻", () => fetchNews(keyword, stock, context), failures),
    settle("东方财富股吧", () => fetchComments(stock, context), failures),
    settle("百度百科", () => fetchBaike(keyword, context), failures),
    profile?.website
      ? settle("公司官网", () => fetchOfficialSite(profile.website!, context), failures)
      : Promise.resolve(null),
    ...((input.documentPaths ?? []).map((filePath) => settle("本地文档", () => readDocument(filePath, input.knowledgeRoot, store, retrievedAt), failures))),
  ]);
  onProgress("新闻、舆情与本地文档处理结束");

  const orderedFinancials = (financials ?? []).slice().sort((left, right) => compareCivil(left.reportDate, right.reportDate));
  const latest = orderedFinancials.at(-1) ?? null;
  const ratios = latest ? ratioView(latest, orderedFinancials) : null;
  const points = history?.points ?? [];
  const drawdowns = periodDrawdowns(points, history?.evidenceId ?? null);
  const trend = buildTrend(points, history?.evidenceId ?? null);
  const evidence = store.list();
  const negativeNews = evidence.filter((item) => item.sentiment === "negative");
  const policyEvidenceIds = evidence
    .filter((item) => POLICY_WORDS.some((word) => `${item.title}${item.summary}`.includes(word)))
    .map((item) => item.id);
  const previousDebt = previousDebtRatio(orderedFinancials, latest);
  const risks = assessRisks({
    ratios,
    previousDebt,
    drawdowns,
    negativeNews: negativeNews.length,
    newsEvidenceIds: negativeNews.map((item) => item.id),
    generalManager: profile?.generalManager ?? null,
    managerEvidenceId: profile?.evidenceId ?? null,
    policyEvidenceIds,
  });
  return {
    stock,
    generatedAt: retrievedAt,
    profile,
    quote,
    financials: orderedFinancials,
    ratios,
    prices: points,
    drawdowns,
    trend,
    holders: holders ?? [],
    risks,
    evidence,
    failures,
    charts: charts(orderedFinancials, points, drawdowns, evidence, holders ?? [], risks),
  };
}

async function readDocument(filePath: string, root: string | undefined, store: EvidenceStore, retrievedAt: string): Promise<void> {
  if (!root) throw new Error("没有配置知识库目录");
  const drafts = await parseLocalDocument(filePath, root, retrievedAt);
  for (const draft of drafts) store.add(draft);
}

function ratioView(latest: ReportedFinancials, financials: ReportedFinancials[]): RatioView {
  const previous = financials.find((item) => item !== latest && item.reportType === latest.reportType && Number(item.reportDate.slice(0, 4)) === Number(latest.reportDate.slice(0, 4)) - 1);
  const oldRevenue = previous?.figures.revenue;
  return {
    ...calculateFinancialRatios(latest.figures),
    reportDate: latest.reportDate,
    reportType: latest.reportType,
    profitBasis: latest.profitBasis,
    evidenceIds: latest.evidenceIds,
    revenueYoY: oldRevenue && oldRevenue > 0 ? latest.figures.revenue / oldRevenue - 1 : null,
  };
}

function previousDebtRatio(financials: ReportedFinancials[], latest: ReportedFinancials | null): number | null {
  if (!latest) return null;
  const previous = financials.find((item) => item !== latest && item.reportType === latest.reportType && Number(item.reportDate.slice(0, 4)) === Number(latest.reportDate.slice(0, 4)) - 1);
  if (!previous) return null;
  const ratios: FinancialRatios = calculateFinancialRatios(previous.figures);
  return ratios.debtToAsset;
}

function buildTrend(points: PricePoint[], evidenceId: string | null): TrendSnapshot {
  const last = points.at(-1);
  return {
    lastDate: last?.date ?? null,
    lastClose: last?.close ?? null,
    ma20: movingAverage(points, 20),
    ma60: movingAverage(points, 60),
    annualizedVolatility: volatility(points),
    adjustment: "前复权",
    evidenceId,
  };
}

function movingAverage(points: PricePoint[], window: number): number | null {
  if (points.length < window) return null;
  const slice = points.slice(-window);
  return slice.reduce((sum, point) => sum + point.close, 0) / window;
}

function volatility(points: PricePoint[]): number | null {
  const returns: number[] = [];
  for (let index = Math.max(1, points.length - 252); index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current || previous.close <= 0) continue;
    returns.push(current.close / previous.close - 1);
  }
  if (returns.length < 20) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

function charts(
  financials: ReportedFinancials[],
  points: PricePoint[],
  drawdowns: PeriodDrawdown[],
  evidence: ResearchPackage["evidence"],
  holders: HolderPosition[],
  risks: ResearchPackage["risks"],
): ChartBundle {
  return {
    financials: {
      periods: financials.map((item) => `${item.reportDate.slice(0, 7)} ${item.reportType}`),
      revenue: financials.map((item) => item.figures.revenue),
      netIncome: financials.map((item) => item.figures.netIncome),
      operatingCashFlow: financials.map((item) => finiteOrNull(item.figures.operatingCashFlow)),
    },
    margins: {
      periods: financials.map((item) => `${item.reportDate.slice(0, 7)} ${item.reportType}`),
      gross: financials.map((item) => calculateFinancialRatios(item.figures).grossMargin),
      net: financials.map((item) => calculateFinancialRatios(item.figures).netMargin),
      roe: financials.map((item) => calculateFinancialRatios(item.figures).returnOnEquity),
      debt: financials.map((item) => calculateFinancialRatios(item.figures).debtToAsset),
    },
    capital: latestCapital(financials.at(-1)),
    prices: { dates: points.map((point) => point.date), closes: points.map((point) => point.close) },
    drawdowns: {
      labels: drawdowns.map((item) => item.label),
      rates: drawdowns.map((item) => item.result?.rate ?? null),
    },
    sentiment: {
      positive: evidence.filter((item) => item.sentiment === "positive").length,
      negative: evidence.filter((item) => item.sentiment === "negative").length,
      neutral: evidence.filter((item) => item.sentiment === "neutral").length,
    },
    holders: holders.filter((item) => item.ratioPercent !== null).map((item) => ({ name: item.name, ratioPercent: item.ratioPercent ?? 0 })),
    risks: risks.flatMap((item) => item.impact !== null && item.probability !== null ? [{ name: item.name, impact: item.impact, probability: item.probability }] : []),
  };
}

function latestCapital(snapshot: ReportedFinancials | undefined): ChartBundle["capital"] {
  if (!snapshot) return null;
  const { totalAssets, totalLiabilities, equity } = snapshot.figures;
  if (![totalAssets, totalLiabilities, equity].every(Number.isFinite)) return null;
  return { assets: totalAssets, liabilities: totalLiabilities, equity };
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

async function settle<T>(source: string, action: () => Promise<T>, failures: SourceFailure[]): Promise<T | null> {
  try {
    return await Promise.resolve().then(action);
  } catch (error) {
    const message = error instanceof Error ? error.message : "采集失败";
    failures.push({ source, message: redactSecrets(message) });
    return null;
  }
}

export type { CompanyProfile, QuoteSnapshot };
