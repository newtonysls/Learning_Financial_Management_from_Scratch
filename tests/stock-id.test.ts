import { describe, expect, test } from "vitest";
import { normalizeStockId } from "../src/server/domain/stock-id";

describe("normalizeStockId", () => {
  test("normalizes Shanghai and Shenzhen identifiers", () => {
    expect(normalizeStockId("sh600519")).toEqual({
      code: "600519",
      exchange: "SH",
      canonical: "600519.SH",
    });
    expect(normalizeStockId("000001.SZ").canonical).toBe("000001.SZ");
  });

  test("infers the exchange from the code prefix", () => {
    expect(normalizeStockId(" 688981 ").canonical).toBe("688981.SH");
    expect(normalizeStockId("300750").canonical).toBe("300750.SZ");
  });

  test("rejects malformed and mismatched identifiers", () => {
    expect(() => normalizeStockId("ABC")).toThrow(
      "请输入有效的 6 位沪深 A 股代码",
    );
    expect(() => normalizeStockId("600519.SZ")).toThrow(
      "股票代码与交易所不匹配",
    );
  });
});
