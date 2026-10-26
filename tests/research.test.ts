import { describe, expect, test, vi } from "vitest";
import type {
  CompanyProfile,
  EvidenceRecord,
  FinancialSnapshot,
  PricePoint,
  ResearchSources,
} from "../src/shared/types";
import { buildResearchPackage } from "../src/server/research/build-research";

const stock = {
  code: "600519",
  exchange: "SH" as const,
  canonical: "600519.SH",
};

const profile: CompanyProfile = {
  stock,
  name: "贵州茅台",
  industry: "白酒",
  latestPrice: 1501.23,
  marketCapitalization: 1888123000000,
  sourceUrl: "https://push2.eastmoney.com/api/qt/stock/get",
  retrievedAt: "2026-10-26T11:00:00.000Z",
};

const history: PricePoint[] = [
  { date: "2025-01-01", close: 200 },
  { date: "2026-01-01", close: 100 },
  { date: "2026-07-26", close: 100 },
  { date: "2026-09-26", close: 100 },
  { date: "2026-10-19", close: 120 },
  { date: "2026-10-26", close: 90 },
];

const financial: FinancialSnapshot = {
  reportDate: "2026-06-30",
  totalAssets: 200,
  totalLiabilities: 80,
  currentAssets: 100,
  inventory: 20,
  currentLiabilities: 50,
  revenue: 250,
  costOfRevenue: 150,
  netIncome: 25,
  operatingCashFlow: 30,
  equity: 120,
  interestExpense: 10,
  earningsBeforeInterestAndTax: 40,
  sourceUrl:
    "https://datacenter-web.eastmoney.com/api/data/v1/get",
  retrievedAt: "2026-10-26T11:00:00.000Z",
};

const announcement: EvidenceRecord = {
  id: "cninfo:1",
  sourceGrade: "A",
  title: "2025 年年度报告",
  contentHash: "annual-report",
  sourceUrl:
    "https://static.cninfo.com.cn/finalpage/2026-03-30/annual.pdf",
  publishedAt: "2026-03-30T00:00:00.000Z",
  retrievedAt: "2026-10-26T11:00:00.000Z",
  category: "年度报告",
};

describe("buildResearchPackage", () => {
  test("combines independent sources, ratios, and bounded-period drawdowns", async () => {
    const result = await buildResearchPackage({
      stock,
      historyDays: 400,
      sources: createSources(),
      now: () => "2026-10-26T12:00:00.000Z",
    });

    expect(result).toEqual(
      expect.objectContaining({
        stock,
        profile,
        priceHistory: history,
        financials: [financial],
        announcements: [announcement],
        evidence: [announcement],
        failures: [],
        generatedAt: "2026-10-26T12:00:00.000Z",
      }),
    );
    expect(result.ratios).toEqual(
      expect.objectContaining({
        debtToAsset: 0.4,
        currentRatio: 2,
        grossMargin: 0.4,
      }),
    );
    expect(result.drawdowns).toEqual({
      weekly: expect.objectContaining({ rate: -0.25 }),
      monthly: expect.objectContaining({ rate: -0.25 }),
      quarterly: expect.objectContaining({ rate: -0.25 }),
      yearly: expect.objectContaining({ rate: -0.25 }),
    });
  });

  test("records one-source failure and leaves unavailable values null", async () => {
    const sources = createSources();
    sources.fetchCompanyProfile = vi
      .fn()
      .mockRejectedValue(new Error("quote unavailable"));
    sources.fetchPriceHistory = vi.fn().mockResolvedValue([]);
    sources.fetchFinancials = vi.fn().mockResolvedValue([]);

    const result = await buildResearchPackage({
      stock,
      sources,
      now: () => "2026-10-26T12:00:00.000Z",
    });

    expect(result.profile).toBeNull();
    expect(result.ratios).toBeNull();
    expect(result.drawdowns).toEqual({
      weekly: null,
      monthly: null,
      quarterly: null,
      yearly: null,
    });
    expect(result.announcements).toEqual([announcement]);
    expect(result.failures).toEqual([
      {
        source: "companyProfile",
        message: "quote unavailable",
      },
    ]);
  });

  test("clamps calendar-month windows at month end", async () => {
    const sources = createSources();
    sources.fetchPriceHistory = vi.fn().mockResolvedValue([
      { date: "2026-02-28", close: 120 },
      { date: "2026-03-31", close: 90 },
    ]);

    const result = await buildResearchPackage({
      stock,
      sources,
      now: () => "2026-03-31T12:00:00.000Z",
    });

    expect(result.drawdowns.monthly?.rate).toBeCloseTo(-0.25);
  });
});

function createSources(): ResearchSources {
  return {
    fetchCompanyProfile: vi.fn().mockResolvedValue(profile),
    fetchPriceHistory: vi.fn().mockResolvedValue(history),
    fetchFinancials: vi.fn().mockResolvedValue([financial]),
    fetchAnnouncements: vi.fn().mockResolvedValue([announcement]),
  };
}
