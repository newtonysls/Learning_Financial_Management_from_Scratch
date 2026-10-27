# A 股公司基本面分析 Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建可在本地通过 npm 启动的 A 股基本面分析网页 Agent，采集公开数据和本地文档，计算风险指标，展示图表并导出可追溯报告。

**Architecture:** TypeScript 单仓库包含 Express 分析 API、React/Vite 前端和 Cursor Agent SDK Agent。确定性服务负责股票标识、公开数据采集、证据归一化、财务指标与回撤计算；Agent 读取结构化研究包生成有引用的中文分析。

**Tech Stack:** Node.js 22.13+、TypeScript、Express、React、Vite、ECharts、Vitest、Zod、SQLite/FTS5、Cursor Agent SDK。

## Global Constraints

- 一期仅覆盖沪深 A 股的单股票分析。
- 默认使用 Cursor Agent SDK，模型提供层预留 OpenAI 兼容配置。
- 财务数字和风险指标必须由确定性代码计算并关联证据。
- 免费公开数据源优先；不破解验证码、不绕过登录或访问控制。
- 网页提供交互图表，报告支持 Markdown 与 PDF 打印导出。
- API 密钥只从环境变量读取。

---

### Task 1: 工程骨架、领域模型与量化内核

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `src/shared/types.ts`
- Create: `src/server/domain/stock-id.ts`
- Create: `src/server/analysis/metrics.ts`
- Test: `tests/stock-id.test.ts`
- Test: `tests/metrics.test.ts`

**Interfaces:**
- Produces: `normalizeStockId(input: string): StockId`
- Produces: `calculateMaxDrawdown(points: PricePoint[]): DrawdownResult`
- Produces: `calculateFinancialRatios(financials: FinancialSnapshot): FinancialRatios`

- [ ] **Step 1: Write stock identifier and metric tests**

```ts
import { expect, test } from "vitest";
import { normalizeStockId } from "../src/server/domain/stock-id";
import { calculateMaxDrawdown } from "../src/server/analysis/metrics";

test("normalizes Shanghai and Shenzhen identifiers", () => {
  expect(normalizeStockId("sh600519").canonical).toBe("600519.SH");
  expect(normalizeStockId("000001.SZ").canonical).toBe("000001.SZ");
});

test("calculates peak-to-trough drawdown", () => {
  const result = calculateMaxDrawdown([
    { date: "2026-01-01", close: 10 },
    { date: "2026-01-02", close: 12 },
    { date: "2026-01-03", close: 9 },
  ]);
  expect(result.rate).toBeCloseTo(-0.25);
  expect(result.peakDate).toBe("2026-01-02");
});
```

- [ ] **Step 2: Run tests and confirm missing-module failures**

Run: `npm test -- --run tests/stock-id.test.ts tests/metrics.test.ts`
Expected: FAIL because the implementation modules do not exist.

- [ ] **Step 3: Implement strict identifiers and deterministic calculations**

```ts
export function normalizeStockId(raw: string): StockId {
  const input = raw.trim().toUpperCase().replace(/^SH|^SZ/, "");
  const match = input.match(/^(\d{6})(?:\.(SH|SZ))?$/);
  if (!match) throw new Error("请输入有效的 6 位沪深 A 股代码");
  const exchange = match[2] ?? (/^[569]/.test(match[1]) ? "SH" : "SZ");
  if ((exchange === "SH" && !/^[569]/.test(match[1])) ||
      (exchange === "SZ" && !/^[023]/.test(match[1]))) {
    throw new Error("股票代码与交易所不匹配");
  }
  return { code: match[1], exchange, canonical: `${match[1]}.${exchange}` };
}
```

Implement one-pass peak tracking for drawdown and guarded financial ratios that return `null` for invalid denominators.

- [ ] **Step 4: Run unit tests**

Run: `npm test -- --run tests/stock-id.test.ts tests/metrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vite.config.ts src/shared src/server/domain src/server/analysis tests
git commit -m "feat: add stock domain and metric engine"
```

### Task 2: 公开数据采集、证据治理与本地知识库

**Files:**
- Create: `src/server/sources/http.ts`
- Create: `src/server/sources/eastmoney.ts`
- Create: `src/server/sources/cninfo.ts`
- Create: `src/server/evidence/evidence-store.ts`
- Create: `src/server/documents/parser.ts`
- Create: `src/server/research/build-research.ts`
- Test: `tests/evidence.test.ts`
- Test: `tests/research.test.ts`
- Create: `tests/fixtures/eastmoney-quote.json`
- Create: `tests/fixtures/eastmoney-history.json`

**Interfaces:**
- Consumes: `StockId`, `PricePoint`, metric functions from Task 1.
- Produces: `fetchCompanyProfile(stock): Promise<CompanyProfile>`
- Produces: `fetchPriceHistory(stock, days): Promise<PricePoint[]>`
- Produces: `fetchFinancials(stock): Promise<FinancialSnapshot[]>`
- Produces: `fetchAnnouncements(stock): Promise<EvidenceRecord[]>`
- Produces: `parseLocalDocument(file): Promise<EvidenceRecord[]>`
- Produces: `buildResearchPackage(input): Promise<ResearchPackage>`

- [ ] **Step 1: Write fixture-backed source and evidence tests**

```ts
test("deduplicates evidence and keeps the stronger source", () => {
  const store = new EvidenceStore();
  store.add({ id: "a", sourceGrade: "C", title: "年报", contentHash: "same" });
  store.add({ id: "b", sourceGrade: "A", title: "年报", contentHash: "same" });
  expect(store.list()).toEqual([expect.objectContaining({ id: "b" })]);
});
```

Mock `fetch` with the committed fixtures and assert normalized quote, history and source URLs.

- [ ] **Step 2: Run focused tests**

Run: `npm test -- --run tests/evidence.test.ts tests/research.test.ts`
Expected: FAIL because adapters and store are absent.

- [ ] **Step 3: Implement bounded fetch and adapters**

`safeFetchJson` must enforce HTTPS, reject loopback/private hosts, abort after 12 seconds, retry at most twice and cap response bytes. Eastmoney adapters use public quote/history/financial endpoints; CNInfo adapter uses its public announcement query and stores announcement links, dates and categories.

- [ ] **Step 4: Implement evidence normalization and document parsing**

Use content hashes for deduplication, A–D source grades and explicit retrieval timestamps. Parse PDF text, XLSX sheets, Markdown/TXT/CSV/HTML with file-size and MIME checks; retain page or sheet locators.

- [ ] **Step 5: Implement research orchestration**

Run independent adapters with `Promise.allSettled`, record per-source failures, calculate ratio and weekly/monthly/quarterly/yearly drawdowns, and never substitute fabricated values for unavailable data.

- [ ] **Step 6: Run tests**

Run: `npm test -- --run tests/evidence.test.ts tests/research.test.ts`
Expected: PASS, including one-source-failure degradation.

- [ ] **Step 7: Commit**

```bash
git add src/server/sources src/server/evidence src/server/documents src/server/research tests
git commit -m "feat: add public research data pipeline"
```

### Task 3: Agent、报告生成与引用校验

**Files:**
- Create: `bot/agent.ts`
- Create: `bot/instructions.md`
- Create: `bot/tools/get-research-package.ts`
- Create: `bot/tools/search-evidence.ts`
- Create: `src/server/report/report.ts`
- Create: `src/server/report/citations.ts`
- Create: `evals/evals.config.ts`
- Create: `evals/report-smoke.eval.ts`
- Test: `tests/report.test.ts`

**Interfaces:**
- Consumes: `ResearchPackage` from Task 2.
- Produces: `generateDeterministicReport(pkg): ReportDocument`
- Produces: `validateCitations(report, evidence): CitationValidation`
- Agent tools expose research facts and evidence as read-only JSON.

- [ ] **Step 1: Write report contract tests**

```ts
test("report contains every required section and citations", () => {
  const report = generateDeterministicReport(fixturePackage);
  expect(report.markdown).toContain("## 风险矩阵");
  expect(report.markdown).toContain("## 舆情与媒体观点");
  expect(validateCitations(report, fixturePackage.evidence).valid).toBe(true);
});
```

- [ ] **Step 2: Run the report test**

Run: `npm test -- --run tests/report.test.ts`
Expected: FAIL because report modules do not exist.

- [ ] **Step 3: Implement deterministic fallback report**

Build all required sections from available structured facts, add `[E1]`-style references, disclose missing sections and append data cutoff, source list and non-investment-advice notice. Keep prose synthesis in Agent instructions rather than TypeScript.

- [ ] **Step 4: Add Agent SDK definition, tools and smoke eval**

The instructions require fact/inference/opinion separation, source-grade awareness, conflicting-evidence disclosure and no invented values. Tools have `effect: "read"` and Zod input schemas. The smoke eval asserts successful evidence-tool usage.

- [ ] **Step 5: Run tests and key-free SDK checks**

Run:

```bash
npm test -- --run tests/report.test.ts
npx --yes "@grok/agent-sdk@0.3.0" validate --dir .
npx --yes "@grok/agent-sdk@0.3.0" info --dir . --json
npx --yes "@grok/agent-sdk@0.3.0" eval --dir . --list
npx tsc --noEmit
```

Expected: report test passes; SDK validates and lists the smoke eval; TypeScript has no errors.

- [ ] **Step 6: Commit**

```bash
git add bot src/server/report evals tests/report.test.ts
git commit -m "feat: add evidence-grounded report agent"
```

### Task 4: HTTP API、网页报告与图表导出

**Files:**
- Create: `src/server/app.ts`
- Create: `src/server/jobs/job-store.ts`
- Create: `src/web/main.tsx`
- Create: `src/web/App.tsx`
- Create: `src/web/api.ts`
- Create: `src/web/components/MetricCard.tsx`
- Create: `src/web/components/Charts.tsx`
- Create: `src/web/components/Report.tsx`
- Create: `src/web/styles.css`
- Create: `index.html`
- Test: `tests/api.test.ts`
- Test: `tests/web.test.tsx`

**Interfaces:**
- Consumes: `buildResearchPackage`, report generation and shared types.
- Produces: `POST /api/analysis`, `GET /api/analysis/:id`, `GET /api/analysis/:id/report.md`.
- Frontend polls task status and renders `AnalysisResult`.

- [ ] **Step 1: Write API and UI tests**

```ts
test("rejects invalid stock codes", async () => {
  await request(app).post("/api/analysis").send({ stockCode: "ABC" }).expect(400);
});

test("submits an analysis from the landing form", async () => {
  render(<App />);
  await userEvent.type(screen.getByLabelText("股票代码"), "600519");
  await userEvent.click(screen.getByRole("button", { name: "开始深度分析" }));
  expect(fetch).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run API/UI tests**

Run: `npm test -- --run tests/api.test.ts tests/web.test.tsx`
Expected: FAIL because API and frontend do not exist.

- [ ] **Step 3: Implement bounded in-process jobs and API**

Validate requests with Zod, allow only supported upload types and 20 MB total, limit concurrent analysis to two, expose explicit progress/source failure states, and serve Markdown downloads with safe filenames.

- [ ] **Step 4: Implement the Chinese research workspace**

Create a responsive dashboard with code form, file upload, progress steps, executive summary, metric cards, source confidence, required report sections and citation links. Use ECharts for financial trends, price/drawdown, capital structure, news sentiment and risk matrix.

- [ ] **Step 5: Add exports**

Markdown uses the API download. PDF uses a print stylesheet and browser print, retaining chart canvases and hiding controls.

- [ ] **Step 6: Run focused tests and production build**

Run:

```bash
npm test -- --run tests/api.test.ts tests/web.test.tsx
npm run build
```

Expected: all tests pass and Vite production build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/server/app.ts src/server/jobs src/web index.html tests/api.test.ts tests/web.test.tsx
git commit -m "feat: add analysis dashboard and exports"
```

### Task 5: 完整验证、操作文档与安全收尾

**Files:**
- Create: `.env.example`
- Create: `.gitignore`
- Create: `README.md`
- Modify: `package.json`
- Test: `tests/security.test.ts`

**Interfaces:**
- Consumes: complete application.
- Produces: documented `npm run dev`, `npm test`, `npm run build`, `npm run agent:run`.

- [ ] **Step 1: Add security regression tests**

Cover private/loopback URL blocking, upload path traversal, oversized files, unsupported MIME, malformed source payloads and API-key redaction.

- [ ] **Step 2: Run security tests and confirm failures**

Run: `npm test -- --run tests/security.test.ts`
Expected: at least one assertion fails before final guards are wired.

- [ ] **Step 3: Complete guards and documentation**

Document Node requirement, installation, Cursor credential setup, optional future OpenAI-compatible environment variables, source limitations, legal crawling behavior, data directories, commands and disclaimer. Ignore generated state, uploads, SQLite files, reports and secrets.

- [ ] **Step 4: Run the full verification suite**

Run:

```bash
npm test -- --run
npm run typecheck
npm run build
npx --yes "@grok/agent-sdk@0.3.0" validate --dir .
npx --yes "@grok/agent-sdk@0.3.0" info --dir . --json
```

Expected: every command exits 0.

- [ ] **Step 5: Perform a local browser smoke test**

Run `npm run dev`, submit fixture-backed `600519`, verify progress, charts, citations, Markdown download and print layout. Save screenshot evidence if the environment supports it.

- [ ] **Step 6: Commit**

```bash
git add .env.example .gitignore README.md package.json tests/security.test.ts src
git commit -m "docs: finish local agent setup and safeguards"
```
