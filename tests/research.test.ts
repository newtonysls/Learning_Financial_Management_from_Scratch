import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { buildResearchPackage } from "../src/server/research/build-research";
import { clearOrgCache } from "../src/server/sources/cninfo";
import { marketClient } from "./helpers/market";

beforeEach(() => clearOrgCache());

test("builds a sourced research package from public fixtures", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-"));
  await writeFile(join(root, "note.md"), "主要客户为经销商，前五名客户集中度已在年报披露。");
  const pkg = await buildResearchPackage({
    stockCode: "sh600519",
    now: new Date("2026-11-08T02:00:00.000Z"),
    client: marketClient(),
    documentPaths: [join(root, "note.md")],
    knowledgeRoot: root,
  });
  expect(pkg.stock.canonical).toBe("600519.SH");
  expect(pkg.quote?.price).toBe(200);
  expect(pkg.ratios).toMatchObject({ debtToAsset: 0.4, grossMargin: 0.4, netMargin: 0.1, revenueYoY: 0.25, profitBasis: "年度", reportDate: "2025-12-31" });
  expect(pkg.drawdowns.find((item) => item.period === "year")?.result?.rate).toBeCloseTo(-0.5);
  expect(pkg.drawdowns.find((item) => item.period === "month")?.result?.rate).toBe(0);
  expect(pkg.evidence.some((item) => item.source === "巨潮资讯" && item.category === "01010503||010113")).toBe(true);
  expect(pkg.evidence.some((item) => item.source === "巨潮资讯" && item.title.includes("其他公司"))).toBe(false);
  expect(pkg.evidence.some((item) => item.category === "本地文档" && item.summary.includes("经销商"))).toBe(true);
  expect(pkg.failures).toEqual([]);
});

test("records one source failure without fabricating financials", async () => {
  const pkg = await buildResearchPackage({
    stockCode: "600519",
    now: new Date("2026-11-08T02:00:00.000Z"),
    client: marketClient({ post: () => Promise.reject(new Error("巨潮暂时不可用")) }),
  });
  expect(pkg.failures.map((item) => item.source)).toContain("巨潮资讯公告");
  expect(pkg.quote?.name).toBe("贵州茅台");
  expect(pkg.ratios?.debtToAsset).toBe(0.4);
});

test("rejects non A-share identifiers before fetching", async () => {
  await expect(buildResearchPackage({ stockCode: "510300" })).rejects.toThrow("请输入有效的 6 位沪深 A 股代码");
});
