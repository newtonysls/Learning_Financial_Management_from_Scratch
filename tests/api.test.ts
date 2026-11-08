import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { createApp } from "../src/server/app";
import type { ResearchPackage } from "../src/shared/types";

beforeEach(() => {
  delete process.env.OPENAI_COMPAT_API_KEY;
  delete process.env.OPENAI_COMPAT_BASE_URL;
  delete process.env.OPENAI_COMPAT_MODEL;
});

test("rejects invalid stock codes", async () => {
  const app = await createApp({ research: async () => { throw new Error("不应调用研究流程"); } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试端口不可用");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/analysis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stockCode: "ABC" }),
    });
    expect(response.status).toBe(400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("serves a completed markdown report", async () => {
  const uploadRoot = await mkdtemp(join(tmpdir(), "uploads-"));
  const app = await createApp({ uploadRoot, enhance: false, research: async () => fixturePackage() });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试端口不可用");
    const created = await fetch(`http://127.0.0.1:${address.port}/api/analysis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stockCode: "600519" }),
    });
    expect(created.status).toBe(202);
    const { id } = await created.json() as { id: string };
    let markdown = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const report = await fetch(`http://127.0.0.1:${address.port}/api/analysis/${id}/report.md`);
      if (report.status === 200) {
        markdown = await report.text();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(markdown).toContain("## 风险矩阵");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function fixturePackage(): ResearchPackage {
  return {
    stock: { code: "600519", exchange: "SH", canonical: "600519.SH" },
    generatedAt: "2026-11-08T02:00:00.000Z",
    profile: null,
    quote: null,
    financials: [],
    ratios: null,
    prices: [],
    drawdowns: [
      { period: "week", label: "周", start: "2026-11-02", complete: false, result: null, evidenceId: null },
      { period: "month", label: "月", start: "2026-10-08", complete: false, result: null, evidenceId: null },
      { period: "quarter", label: "季", start: "2026-08-08", complete: false, result: null, evidenceId: null },
      { period: "year", label: "年", start: "2025-11-08", complete: false, result: null, evidenceId: null },
    ],
    trend: { lastDate: null, lastClose: null, ma20: null, ma60: null, annualizedVolatility: null, adjustment: "前复权", evidenceId: null },
    holders: [],
    risks: [],
    evidence: [],
    failures: [],
    charts: {
      financials: { periods: [], revenue: [], netIncome: [], operatingCashFlow: [] },
      margins: { periods: [], gross: [], net: [], roe: [], debt: [] },
      capital: null,
      prices: { dates: [], closes: [] },
      drawdowns: { labels: [], rates: [] },
      sentiment: { positive: 0, negative: 0, neutral: 0 },
      holders: [],
      risks: [],
    },
  };
}
