import { useState } from "react";
import type { FormEvent } from "react";
import type { AnalysisResult } from "../shared/types";
import { readJob, submitAnalysis } from "./api";
import { Charts } from "./components/Charts";
import { MetricCard } from "./components/MetricCard";
import { Report } from "./components/Report";

export function App() {
  const [stockCode, setStockCode] = useState("600519");
  const [files, setFiles] = useState<FileList | null>(null);
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    setProgress(["正在提交"]);
    const form = new FormData();
    form.set("stockCode", stockCode);
    if (files) Array.from(files).forEach((file) => form.append("documents", file));
    try {
      const id = await submitAnalysis(form);
      setJobId(id);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const job = await readJob(id);
        setProgress(job.progress);
        if (job.status === "succeeded" && job.result) {
          setResult(job.result);
          return;
        }
        if (job.status === "failed") throw new Error(job.error ?? "分析失败");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("分析超时，请稍后查看任务状态");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "分析失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="hero">
        <div className="seal">研</div>
        <div>
          <p className="eyebrow">A-SHARE FUNDAMENTAL DESK</p>
          <h1>沪深基本面研究台</h1>
          <p>官方公告、公开财务、行情、新闻、股吧与本地文档交叉印证。数字由代码复算，结论逐条引用。</p>
        </div>
      </header>
      <main>
        <form className="panel noprint" onSubmit={onSubmit}>
          <label htmlFor="stockCode">股票代码</label>
          <input id="stockCode" value={stockCode} onChange={(event) => setStockCode(event.target.value)} placeholder="600519 或 600519.SH" />
          <label htmlFor="documents">本地文档</label>
          <input id="documents" type="file" multiple accept=".pdf,.txt,.md,.csv,.html,.xlsx" onChange={(event) => setFiles(event.target.files)} />
          <button type="submit" disabled={busy}>{busy ? "正在分析" : "开始深度分析"}</button>
          <p className="status" role="status">{error || progress.at(-1) || "等待输入一只沪深 A 股。"}</p>
          {progress.length > 1 && <ol>{progress.map((item) => <li key={item}>{item}</li>)}</ol>}
        </form>
        {result && <Result result={result} jobId={jobId} />}
      </main>
    </div>
  );
}

function Result({ result, jobId }: { result: AnalysisResult; jobId: string }) {
  const ratio = result.ratios;
  const yearly = result.drawdowns.find((item) => item.period === "year");
  return (
    <section className="results">
      <div className="toolbar noprint">
        <a href={`/api/analysis/${jobId}/report.md`}>导出 Markdown</a>
        <button type="button" onClick={() => window.print()}>导出 PDF</button>
        <span>{result.narrativeMode === "model" ? "模型已在不改数字的前提下润色" : "当前为确定性报告"}</span>
      </div>
      <section className="metrics">
        <MetricCard label="资产负债率" value={percent(ratio?.debtToAsset)} note={ratio ? `${ratio.reportDate} ${ratio.profitBasis}` : "无报表"} />
        <MetricCard label="毛利率" value={percent(ratio?.grossMargin)} note="营业总收入口径" />
        <MetricCard label="ROE" value={percent(ratio?.returnOnEquity)} note={ratio?.profitBasis ?? "数据不足"} />
        <MetricCard label="年最大回撤" value={percent(yearly?.result?.rate)} note={yearly?.complete ? "完整年度窗口" : "样本未覆盖"} />
      </section>
      <section className="split">
        <article>
          <h2>证据与缺口</h2>
          <p>已保留 {result.evidence.length} 条证据，{result.failures.length} 个来源失败。</p>
          {result.failures.length > 0 && <ul>{result.failures.map((item) => <li key={item.source}>{item.source}：{item.message}</li>)}</ul>}
        </article>
        <article>
          <h2>公司快照</h2>
          <p>{result.profile?.introduction ?? "公司介绍尚未取得。"}</p>
          <p>{result.profile?.businessScope ?? "业务范围尚未取得。"}</p>
        </article>
      </section>
      <Charts charts={result.charts} />
      <Report markdown={result.reportMarkdown} />
    </section>
  );
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "数据不足";
  return `${(value * 100).toFixed(2)}%`;
}
