import type {
  DrawdownResult,
  FinancialRatios,
  FinancialSnapshot,
  PricePoint,
} from "../../shared/types";

export function calculateMaxDrawdown(
  points: PricePoint[],
): DrawdownResult {
  if (points.length === 0) {
    throw new Error("价格序列不能为空");
  }

  const first = points[0] as PricePoint;
  assertValidClose(first.close);

  let peak = first;
  let drawdownPeak = first;
  let trough = first;
  let minimumRate = 0;

  for (let index = 1; index < points.length; index += 1) {
    const point = points[index] as PricePoint;
    assertValidClose(point.close);

    if (point.close > peak.close) {
      peak = point;
      continue;
    }

    const rate = point.close / peak.close - 1;
    if (rate < minimumRate) {
      minimumRate = rate;
      drawdownPeak = peak;
      trough = point;
    }
  }

  return {
    rate: minimumRate,
    peakDate: drawdownPeak.date,
    troughDate: trough.date,
    peak: drawdownPeak.close,
    trough: trough.close,
  };
}

export function calculateFinancialRatios(
  financials: FinancialSnapshot,
): FinancialRatios {
  return {
    debtToAsset: safeDivide(
      financials.totalLiabilities,
      financials.totalAssets,
    ),
    currentRatio: safeDivide(
      financials.currentAssets,
      financials.currentLiabilities,
    ),
    quickRatio: safeDivide(
      financials.currentAssets - financials.inventory,
      financials.currentLiabilities,
    ),
    interestCoverage: safeDivide(
      financials.earningsBeforeInterestAndTax,
      financials.interestExpense,
    ),
    grossMargin: safeDivide(
      financials.revenue - financials.costOfRevenue,
      financials.revenue,
    ),
    netMargin: safeDivide(financials.netIncome, financials.revenue),
    returnOnEquity: safeDivide(financials.netIncome, financials.equity),
    returnOnAssets: safeDivide(
      financials.netIncome,
      financials.totalAssets,
    ),
    cashToProfit: safeDivide(
      financials.operatingCashFlow,
      financials.netIncome,
    ),
  };
}

function assertValidClose(close: number): void {
  if (!Number.isFinite(close) || close <= 0) {
    throw new Error("收盘价必须是正的有限数值");
  }
}

function safeDivide(numerator: number, denominator: number): number | null {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return null;
  }

  return numerator / denominator;
}
