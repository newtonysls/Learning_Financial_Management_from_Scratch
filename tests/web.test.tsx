/** @vitest-environment happy-dom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { App } from "../src/web/App";

vi.mock("echarts", () => ({ init: () => ({ setOption() {}, dispose() {}, resize() {} }) }));

test("submits an analysis from the landing form", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/analysis") && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "job1" }), { status: 202 });
    }
    return new Response(JSON.stringify({ id: "job1", status: "succeeded", progress: ["完成"], result: emptyResult() }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  await userEvent.clear(screen.getByLabelText("股票代码"));
  await userEvent.type(screen.getByLabelText("股票代码"), "600519");
  await userEvent.click(screen.getByRole("button", { name: "开始深度分析" }));
  expect(await screen.findByText("证据与缺口")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalled();
});

function emptyResult() {
  return {
    stock: { code: "600519", exchange: "SH", canonical: "600519.SH" },
    generatedAt: "2026-11-08T02:00:00.000Z",
    profile: { name: "贵州茅台", shortName: "贵州茅台", industry: "白酒", region: "贵州", website: null, introduction: "公司生产茅台酒。", businessScope: "酒类销售", employees: 10, registeredCapital: "1亿", chairman: "陈华", generalManager: "王莉", independentDirectors: null, evidenceId: "E1" },
    quote: null,
    financials: [],
    ratios: null,
    prices: [],
    drawdowns: [],
    trend: { lastDate: null, lastClose: null, ma20: null, ma60: null, annualizedVolatility: null, adjustment: "前复权", evidenceId: null },
    holders: [],
    risks: [],
    evidence: [],
    failures: [],
    charts: { financials: { periods: [], revenue: [], netIncome: [], operatingCashFlow: [] }, margins: { periods: [], gross: [], net: [], roe: [], debt: [] }, capital: null, prices: { dates: [], closes: [] }, drawdowns: { labels: [], rates: [] }, sentiment: { positive: 0, negative: 0, neutral: 0 }, holders: [], risks: [] },
    reportMarkdown: "# 贵州茅台\n\n## 风险矩阵\n\n无\n\n## 舆情与媒体观点\n\n无",
    narrativeMode: "deterministic",
  };
}
