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

  test("accepts the supported Shanghai and Shenzhen A-share segments", () => {
    for (const code of ["600000", "601000", "603000", "605000", "688000"]) {
      expect(normalizeStockId(code).exchange).toBe("SH");
    }

    for (const code of [
      "000001",
      "001000",
      "002000",
      "003000",
      "300000",
      "301000",
    ]) {
      expect(normalizeStockId(code).exchange).toBe("SZ");
    }
  });

  test("rejects ETF, B-share, and CDR identifiers", () => {
    for (const code of ["510300", "900901", "200002", "689009"]) {
      expect(() => normalizeStockId(code)).toThrow(
        "请输入有效的 6 位沪深 A 股代码",
      );
    }
  });

  test("rejects an exchange prefix that conflicts with the code", () => {
    expect(() => normalizeStockId("SH000001")).toThrow(
      "股票代码与交易所不匹配",
    );
    expect(() => normalizeStockId("SZ600519")).toThrow(
      "股票代码与交易所不匹配",
    );
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
