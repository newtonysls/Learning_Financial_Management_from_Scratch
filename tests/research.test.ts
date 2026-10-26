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

const profileEvidence: EvidenceRecord = {
  id: "eastmoney:profile:600519.SH",
  sourceGrade: "C",
  title: "600519.SH 公司概况",
  contentHash: "profile",
  sourceUrl: "https://push2.eastmoney.com/api/qt/stock/get",
  retrievedAt: "2026-10-26T11:00:00.000Z",
};

const profile: CompanyProfile = {
  stock,
  name: "贵州茅台",
  industry: "白酒",
  latestPrice: 1501.23,
  marketCapitalization: 1888123000000,
  sourceUrl: "https://push2.eastmoney.com/api/qt/stock/get",
  retrievedAt: "2026-10-26T11:00:00.000Z",
  evidence: profileEvidence,
};

const priceEvidence: EvidenceRecord = {
  id: "eastmoney:prices:600519.SH",
  sourceGrade: "C",
  title: "600519.SH 历史行情",
  contentHash: "prices",
  sourceUrl:
    "https://push2his.eastmoney.com/api/qt/stock/kline/get",
  retrievedAt: "2026-10-26T11:00:00.000Z",
};

const history: PricePoint[] = [
  { date: "2025-01-01", close: 200, evidence: priceEvidence },
  { date: "2026-01-01", close: 100, evidence: priceEvidence },
  { date: "2026-07-26", close: 100, evidence: priceEvidence },
  { date: "2026-09-26", close: 100, evidence: priceEvidence },
  { date: "2026-10-19", close: 120, evidence: priceEvidence },
  { date: "2026-10-26", close: 90, evidence: priceEvidence },
];

const financialEvidence: EvidenceRecord = {
  id: "eastmoney:financial:600519.SH:2026-06-30",
  sourceGrade: "C",
  title: "600519.SH 2026-06-30 财务报表",
  contentHash: "financial",
  sourceUrls: [
    "https://datacenter.eastmoney.com/securities/api/data/get",
  ],
  retrievedAt: "2026-10-26T11:00:00.000Z",
};

const financial: FinancialSnapshot = {
  reportDate: "2026-06-30",
  reportType: "中报",
  periodScope: "year-to-date",
  annualized: false,
  currency: "CNY",
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
  interestExpenseBasis: "FE_INTEREST_EXPENSE",
  sourceUrl:
    "https://datacenter.eastmoney.com/securities/api/data/get",
  retrievedAt: "2026-10-26T11:00:00.000Z",
  evidence: financialEvidence,
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
        evidence: [
          profileEvidence,
          priceEvidence,
          financialEvidence,
          announcement,
        ],
        failures: [],
        generatedAt: "2026-10-26T12:00:00.000Z",
      }),
    );
    expect(result.ratios).toEqual(
      expect.objectContaining({
        values: expect.objectContaining({
          debtToAsset: 0.4,
          currentRatio: 2,
          grossMargin: 0.4,
        }),
        evidenceIds: [financialEvidence.id],
        retrievedAt: "2026-10-26T11:00:00.000Z",
        reportDate: "2026-06-30",
        reportType: "中报",
        periodScope: "year-to-date",
        annualized: false,
      }),
    );
    expect(result.drawdowns).toEqual({
      weekly: expect.objectContaining({
        result: expect.objectContaining({ rate: -0.25 }),
        evidenceIds: [priceEvidence.id],
        retrievedAt: "2026-10-26T11:00:00.000Z",
        coverage: "full",
      }),
      monthly: expect.objectContaining({
        result: expect.objectContaining({ rate: -0.25 }),
      }),
      quarterly: expect.objectContaining({
        result: expect.objectContaining({ rate: -0.25 }),
      }),
      yearly: expect.objectContaining({
        result: expect.objectContaining({ rate: -0.25 }),
      }),
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

    expect(result.drawdowns.monthly?.result.rate).toBeCloseTo(-0.25);
  });

  test("returns null when price history does not cover a complete window", async () => {
    const sources = createSources();
    sources.fetchPriceHistory = vi.fn().mockResolvedValue([
      { date: "2026-10-20", close: 120, evidence: priceEvidence },
      { date: "2026-10-26", close: 90, evidence: priceEvidence },
    ]);

    const result = await buildResearchPackage({
      stock,
      sources,
      now: () => "2026-10-26T12:00:00.000Z",
    });

    expect(result.drawdowns).toEqual({
      weekly: null,
      monthly: null,
      quarterly: null,
      yearly: null,
    });
  });

  test("captures synchronous adapter throws through allSettled", async () => {
    const sources = createSources();
    sources.fetchCompanyProfile = vi.fn(() => {
      throw new Error("synchronous quote failure");
    });

    const result = await buildResearchPackage({
      stock,
      sources,
      now: () => "2026-10-26T12:00:00.000Z",
    });

    expect(result.profile).toBeNull();
    expect(result.failures).toContainEqual({
      source: "companyProfile",
      message: "synchronous quote failure",
    });
  });

  test("sorts financials by report date before choosing ratio inputs", async () => {
    const sources = createSources();
    const older = {
      ...financial,
      reportDate: "2025-12-31",
      reportType: "年报",
      periodScope: "annual" as const,
      totalAssets: 100,
      totalLiabilities: 10,
      evidence: {
        ...financialEvidence,
        id: "eastmoney:financial:600519.SH:2025-12-31",
      },
    };
    sources.fetchFinancials = vi
      .fn()
      .mockResolvedValue([older, financial]);

    const result = await buildResearchPackage({
      stock,
      sources,
      now: () => "2026-10-26T12:00:00.000Z",
    });

    expect(result.financials.map((item) => item.reportDate)).toEqual([
      "2026-06-30",
      "2025-12-31",
    ]);
    expect(result.ratios?.reportDate).toBe("2026-06-30");
    expect(result.ratios?.values.debtToAsset).toBe(0.4);
  });

  test("rejects invalid StockId before invoking any source", async () => {
    const sources = createSources();

    await expect(
      buildResearchPackage({
        stock: {
          code: "510300",
          exchange: "SH",
          canonical: "510300.SH",
        },
        sources,
      }),
    ).rejects.toThrow("6 位沪深 A 股代码");
    for (const source of Object.values(sources)) {
      expect(source).not.toHaveBeenCalled();
    }
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
