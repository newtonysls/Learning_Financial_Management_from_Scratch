import { describe, expect, test } from "vitest";
import {
  calculateFinancialRatios,
  calculateMaxDrawdown,
} from "../src/server/analysis/metrics";

describe("calculateMaxDrawdown", () => {
  test("calculates peak-to-trough drawdown", () => {
    const result = calculateMaxDrawdown([
      { date: "2026-01-01", close: 10 },
      { date: "2026-01-02", close: 12 },
      { date: "2026-01-03", close: 9 },
    ]);

    expect(result.rate).toBeCloseTo(-0.25);
    expect(result.peakDate).toBe("2026-01-02");
    expect(result.troughDate).toBe("2026-01-03");
    expect(result.peak).toBe(12);
    expect(result.trough).toBe(9);
  });

  test("returns zero drawdown for a rising series", () => {
    expect(
      calculateMaxDrawdown([
        { date: "2026-01-01", close: 10 },
        { date: "2026-01-02", close: 11 },
      ]),
    ).toEqual({
      rate: 0,
      peakDate: "2026-01-01",
      troughDate: "2026-01-01",
      peak: 10,
      trough: 10,
    });
  });

  test("rejects empty series and non-positive prices", () => {
    expect(() => calculateMaxDrawdown([])).toThrow("价格序列不能为空");
    expect(() =>
      calculateMaxDrawdown([{ date: "2026-01-01", close: 0 }]),
    ).toThrow("收盘价必须是正的有限数值");
  });
});

describe("calculateFinancialRatios", () => {
  test("calculates deterministic financial ratios", () => {
    expect(
      calculateFinancialRatios({
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
      }),
    ).toEqual({
      debtToAsset: 0.4,
      currentRatio: 2,
      quickRatio: 1.6,
      interestCoverage: 4,
      grossMargin: 0.4,
      netMargin: 0.1,
      returnOnEquity: 25 / 120,
      returnOnAssets: 0.125,
      cashToProfit: 1.2,
    });
  });

  test("returns null when a denominator is zero, negative, or non-finite", () => {
    const ratios = calculateFinancialRatios({
      totalAssets: 0,
      totalLiabilities: 80,
      currentAssets: 100,
      inventory: 20,
      currentLiabilities: -1,
      revenue: Number.NaN,
      costOfRevenue: 150,
      netIncome: 0,
      operatingCashFlow: 30,
      equity: 0,
      interestExpense: 0,
      earningsBeforeInterestAndTax: 40,
    });

    expect(ratios).toEqual({
      debtToAsset: null,
      currentRatio: null,
      quickRatio: null,
      interestCoverage: null,
      grossMargin: null,
      netMargin: null,
      returnOnEquity: null,
      returnOnAssets: null,
      cashToProfit: null,
    });
  });
});
