import { expect, test } from "vitest";
import { EvidenceStore, searchEvidence } from "../src/server/evidence/evidence-store";
import type { EvidenceDraft } from "../src/shared/types";

const base: EvidenceDraft = {
  source: "测试",
  sourceGrade: "C",
  title: "年报",
  url: "https://example.com/a",
  publisher: "测试",
  publishedAt: "2026-01-01",
  retrievedAt: "2026-11-08T00:00:00.000Z",
  reportPeriod: "2025-12-31",
  summary: "营业收入增长",
  contentHash: "same",
  locator: null,
  category: "财务",
  sentiment: null,
};

test("deduplicates evidence and keeps the stronger source", () => {
  const store = new EvidenceStore();
  store.add(base);
  store.add({ ...base, sourceGrade: "A", source: "巨潮资讯", summary: "法定年报营业收入" });
  expect(store.list()).toEqual([expect.objectContaining({ id: "E1", sourceGrade: "A", source: "巨潮资讯" })]);
});

test("searches Chinese evidence with FTS", () => {
  const store = new EvidenceStore();
  const financial = store.add(base);
  store.add({ ...base, contentHash: "other", title: "股价", summary: "今日收盘" });
  expect(searchEvidence(store.list(), "营业收入").map((item) => item.id)).toEqual([financial.id]);
});
