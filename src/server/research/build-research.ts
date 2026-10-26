import type {
  BuildResearchInput,
  CompanyProfile,
  EvidenceRecord,
  FinancialSnapshot,
  PeriodDrawdowns,
  PricePoint,
  RatioAnalysis,
  ResearchFailure,
  ResearchPackage,
  ResearchSources,
} from "../../shared/types";
import {
  calculateFinancialRatios,
  calculateMaxDrawdown,
} from "../analysis/metrics";
import { parseLocalDocument } from "../documents/parser";
import { assertStockId } from "../domain/stock-id";
import {
  EvidenceStore,
  hashContent,
} from "../evidence/evidence-store";
import { fetchAnnouncements } from "../sources/cninfo";
import {
  fetchCompanyProfile,
  fetchFinancials,
  fetchPriceHistory,
} from "../sources/eastmoney";

const DEFAULT_HISTORY_DAYS = 400;

const defaultSources: ResearchSources = {
  fetchCompanyProfile,
  fetchPriceHistory,
  fetchFinancials,
  fetchAnnouncements,
};

export async function buildResearchPackage(
  input: BuildResearchInput,
): Promise<ResearchPackage> {
  const stock = assertStockId(input.stock);
  const generatedAt = (input.now ?? (() => new Date().toISOString()))();
  const sources = input.sources ?? defaultSources;
  const historyDays = validateHistoryDays(
    input.historyDays ?? DEFAULT_HISTORY_DAYS,
  );

  const sourceResults = await Promise.allSettled([
    invokeSource(() => sources.fetchCompanyProfile(stock)),
    invokeSource(() => sources.fetchPriceHistory(stock, historyDays)),
    invokeSource(() => sources.fetchFinancials(stock)),
    invokeSource(() => sources.fetchAnnouncements(stock)),
  ] as const);

  const failures: ResearchFailure[] = [];
  const rawProfile = settledValue(
    sourceResults[0],
    "companyProfile",
    null,
    failures,
  );
  const rawPriceHistory = settledValue(
    sourceResults[1],
    "priceHistory",
    [],
    failures,
  );
  const rawFinancials = settledValue(
    sourceResults[2],
    "financials",
    [],
    failures,
  );
  const announcements = settledValue(
    sourceResults[3],
    "announcements",
    [],
    failures,
  );
  const profile = rawProfile
    ? ensureProfileEvidence(rawProfile, generatedAt)
    : null;
  const priceHistory = ensurePriceEvidence(
    rawPriceHistory,
    stock.canonical,
    generatedAt,
  );
  const financials = rawFinancials
    .map((snapshot) =>
      ensureFinancialEvidence(
        snapshot,
        stock.canonical,
        generatedAt,
      ),
    )
    .sort((left, right) =>
      (right.reportDate ?? "").localeCompare(left.reportDate ?? ""),
    );

  const localResults = await Promise.allSettled(
    (input.localDocumentPaths ?? []).map((filePath) =>
      Promise.resolve().then(() =>
        parseLocalDocument(filePath, {
          knowledgeBaseRoot: input.knowledgeBaseRoot,
        }),
      ),
    ),
  );
  const localEvidence = localResults.flatMap((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    failures.push({
      source: "localDocument",
      path: input.localDocumentPaths?.[index],
      message: errorMessage(result.reason),
    });
    return [];
  });

  const evidenceStore = new EvidenceStore(() => generatedAt);
  if (profile?.evidence) {
    evidenceStore.add(profile.evidence);
  }
  const priceEvidence = priceHistory[0]?.evidence;
  if (priceEvidence) {
    evidenceStore.add(priceEvidence);
  }
  evidenceStore.addMany(
    financials.flatMap((snapshot) =>
      snapshot.evidence ? [snapshot.evidence] : [],
    ),
  );
  evidenceStore.addMany(announcements);
  evidenceStore.addMany(localEvidence);

  return {
    stock: { ...stock },
    profile,
    priceHistory,
    financials,
    announcements,
    evidence: evidenceStore.list(),
    ratios: buildRatioAnalysis(financials[0]),
    drawdowns: calculatePeriodDrawdowns(priceHistory),
    failures,
    generatedAt,
  };
}

function settledValue<T>(
  result: PromiseSettledResult<T>,
  source: Exclude<ResearchFailure["source"], "localDocument">,
  fallback: T,
  failures: ResearchFailure[],
): T {
  if (result.status === "fulfilled") {
    return result.value;
  }
  failures.push({
    source,
    message: errorMessage(result.reason),
  });
  return fallback;
}

function invokeSource<T>(operation: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(operation);
}

function ensureProfileEvidence(
  profile: CompanyProfile,
  retrievedAt: string,
): CompanyProfile {
  if (profile.evidence) {
    return profile;
  }
  const content = JSON.stringify({
    stock: profile.stock,
    name: profile.name,
    industry: profile.industry,
    latestPrice: profile.latestPrice,
    marketCapitalization: profile.marketCapitalization,
  });
  return {
    ...profile,
    evidence: {
      id: `research:profile:${profile.stock.canonical}`,
      sourceGrade: "C",
      title: `${profile.stock.canonical} 公司概况`,
      content,
      contentType: "text/plain",
      contentHash: hashContent(content),
      sourceUrl: profile.sourceUrl,
      retrievedAt: profile.retrievedAt || retrievedAt,
    },
  };
}

function ensurePriceEvidence(
  points: PricePoint[],
  canonical: string,
  retrievedAt: string,
): PricePoint[] {
  if (points.length === 0) {
    return [];
  }
  const existingEvidence = points.find(
    (point) => point.evidence,
  )?.evidence;
  const content = JSON.stringify(
    points.map(({ date, close }) => ({ date, close })),
  );
  const evidence: EvidenceRecord = existingEvidence ?? {
    id: `research:prices:${canonical}`,
    sourceGrade: "C",
    title: `${canonical} 历史行情`,
    content,
    contentType: "text/plain",
    contentHash: hashContent(content),
    retrievedAt,
  };
  return points.map((point) => ({ ...point, evidence }));
}

function ensureFinancialEvidence(
  snapshot: FinancialSnapshot,
  canonical: string,
  retrievedAt: string,
): FinancialSnapshot {
  if (snapshot.evidence) {
    return snapshot;
  }
  const content = JSON.stringify(snapshot);
  return {
    ...snapshot,
    evidence: {
      id: `research:financial:${canonical}:${snapshot.reportDate ?? "unknown"}`,
      sourceGrade: "C",
      title: `${canonical} ${snapshot.reportDate ?? "未知报告期"} 财务报表`,
      content,
      contentType: "text/plain",
      contentHash: hashContent(content),
      sourceUrl: snapshot.sourceUrl,
      retrievedAt: snapshot.retrievedAt ?? retrievedAt,
    },
  };
}

function buildRatioAnalysis(
  snapshot: FinancialSnapshot | undefined,
): RatioAnalysis | null {
  if (
    !snapshot ||
    !snapshot.reportDate ||
    !snapshot.reportType ||
    !snapshot.periodScope ||
    !snapshot.evidence
  ) {
    return null;
  }
  return {
    values: calculateFinancialRatios(snapshot),
    evidenceIds: [snapshot.evidence.id],
    retrievedAt:
      snapshot.retrievedAt ?? snapshot.evidence.retrievedAt,
    reportDate: snapshot.reportDate,
    reportType: snapshot.reportType,
    periodScope: snapshot.periodScope,
    annualized: false,
  };
}

function calculatePeriodDrawdowns(
  points: PricePoint[],
): PeriodDrawdowns {
  const validPoints = points
    .filter(
      (point) =>
        parseDate(point.date) !== null &&
        Number.isFinite(point.close) &&
        point.close > 0,
    )
    .sort((left, right) => left.date.localeCompare(right.date));
  const latest = validPoints.at(-1);
  if (!latest) {
    return emptyDrawdowns();
  }
  const latestDate = parseDate(latest.date);
  if (!latestDate) {
    return emptyDrawdowns();
  }

  return {
    weekly: drawdownSince(validPoints, shiftUtcDate(latestDate, 0, -7)),
    monthly: drawdownSince(validPoints, shiftUtcDate(latestDate, -1, 0)),
    quarterly: drawdownSince(
      validPoints,
      shiftUtcDate(latestDate, -3, 0),
    ),
    yearly: drawdownSince(validPoints, shiftUtcDate(latestDate, -12, 0)),
  };
}

function drawdownSince(
  points: PricePoint[],
  cutoff: Date,
): PeriodDrawdowns["weekly"] {
  const cutoffTimestamp = cutoff.getTime();
  const earliestDate = parseDate(points[0]?.date ?? "");
  if (!earliestDate || earliestDate.getTime() > cutoffTimestamp) {
    return null;
  }
  const periodPoints = points.filter((point) => {
    const date = parseDate(point.date);
    return date !== null && date.getTime() >= cutoffTimestamp;
  });
  const latest = periodPoints.at(-1);
  if (!latest) {
    return null;
  }
  const evidence = periodPoints
    .map((point) => point.evidence)
    .find((record) => record !== undefined);
  if (!evidence) {
    return null;
  }
  return {
    result: calculateMaxDrawdown(periodPoints),
    evidenceIds: [
      ...new Set(
        periodPoints.flatMap((point) =>
          point.evidence ? [point.evidence.id] : [],
        ),
      ),
    ],
    retrievedAt: evidence.retrievedAt,
    periodStart: cutoff.toISOString().slice(0, 10),
    periodEnd: latest.date,
    coverage: "full",
  };
}

function shiftUtcDate(
  date: Date,
  months: number,
  days: number,
): Date {
  const shifted =
    months === 0
      ? new Date(date.getTime())
      : clampedMonthShift(date, months);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

function clampedMonthShift(date: Date, months: number): Date {
  const targetMonthStart = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1),
  );
  const lastTargetDay = new Date(
    Date.UTC(
      targetMonthStart.getUTCFullYear(),
      targetMonthStart.getUTCMonth() + 1,
      0,
    ),
  ).getUTCDate();
  targetMonthStart.setUTCDate(
    Math.min(date.getUTCDate(), lastTargetDay),
  );
  return targetMonthStart;
}

function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
    ? null
    : date;
}

function emptyDrawdowns(): PeriodDrawdowns {
  return {
    weekly: null,
    monthly: null,
    quarterly: null,
    yearly: null,
  };
}

function validateHistoryDays(days: number): number {
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("history days must be a positive integer");
  }
  return Math.min(days, 5_000);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
