import { beforeEach, expect, test } from "vitest";
import { buildResearchPackage } from "../src/server/research/build-research";
import { validateCitations } from "../src/server/report/citations";
import { generateDeterministicReport } from "../src/server/report/report";
import { clearOrgCache } from "../src/server/sources/cninfo";
import { marketClient } from "./helpers/market";

beforeEach(() => clearOrgCache());

test("report contains every required section and citations", async () => {
  const pkg = await buildResearchPackage({ stockCode: "600519", now: new Date("2026-11-08T02:00:00.000Z"), client: marketClient() });
  const report = generateDeterministicReport(pkg);
  expect(report.markdown).toContain("## 风险矩阵");
  expect(report.markdown).toContain("## 舆情与媒体观点");
  expect(report.markdown).toContain("### 最大回撤");
  expect(report.markdown).toContain("不是投资建议");
  expect(report.markdown).toContain("王莉(代)");
  expect(validateCitations(report.markdown, pkg.evidence).valid).toBe(true);
});
