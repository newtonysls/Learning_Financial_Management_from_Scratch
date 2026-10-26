import type {
  BuildResearchInput,
  PeriodDrawdowns,
  PricePoint,
  ResearchFailure,
  ResearchPackage,
  ResearchSources,
} from "../../shared/types";
import {
  calculateFinancialRatios,
  calculateMaxDrawdown,
} from "../analysis/metrics";
import { parseLocalDocument } from "../documents/parser";
import { EvidenceStore } from "../evidence/evidence-store";
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
  const generatedAt = (input.now ?? (() => new Date().toISOString()))();
  const sources = input.sources ?? defaultSources;
  const historyDays = validateHistoryDays(
    input.historyDays ?? DEFAULT_HISTORY_DAYS,
  );

  const sourceResults = await Promise.allSettled([
    sources.fetchCompanyProfile(input.stock),
    sources.fetchPriceHistory(input.stock, historyDays),
    sources.fetchFinancials(input.stock),
    sources.fetchAnnouncements(input.stock),
  ] as const);

  const failures: ResearchFailure[] = [];
  const profile = settledValue(
    sourceResults[0],
    "companyProfile",
    null,
    failures,
  );
  const priceHistory = settledValue(
    sourceResults[1],
    "priceHistory",
    [],
    failures,
  );
  const financials = settledValue(
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

  const localResults = await Promise.allSettled(
    (input.localDocumentPaths ?? []).map((filePath) =>
      parseLocalDocument(filePath),
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
  evidenceStore.addMany(announcements);
  evidenceStore.addMany(localEvidence);

  return {
    stock: { ...input.stock },
    profile,
    priceHistory,
    financials,
    announcements,
    evidence: evidenceStore.list(),
    ratios:
      financials.length > 0
        ? calculateFinancialRatios(financials[0]!)
        : null,
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
): ReturnType<typeof calculateMaxDrawdown> | null {
  const cutoffTimestamp = cutoff.getTime();
  const periodPoints = points.filter((point) => {
    const date = parseDate(point.date);
    return date !== null && date.getTime() >= cutoffTimestamp;
  });
  return periodPoints.length > 0
    ? calculateMaxDrawdown(periodPoints)
    : null;
}

function shiftUtcDate(
  date: Date,
  months: number,
  days: number,
): Date {
  const shifted = new Date(date.getTime());
  shifted.setUTCMonth(shifted.getUTCMonth() + months);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
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
