import { readFile } from "node:fs/promises";
import { defineTool, type ToolResultValue } from "@grok/agent-sdk";
import { z } from "zod";
import { latestResearchPath } from "../../src/server/paths";
import type { AnalysisResult } from "../../src/shared/types";

export default defineTool({
  description: "读取最近一次单只 A 股研究的财务、回撤、风险和来源缺口。",
  effect: "read",
  inputSchema: z.object({ stockCode: z.string().optional() }),
  async execute({ stockCode }): Promise<{ [key: string]: ToolResultValue }> {
    const research = await readResearch();
    if (!research) return { ok: false, message: "尚无研究结果。请先在研究台完成本地分析。" };
    if (stockCode && !research.stock.canonical.includes(stockCode.toUpperCase()) && research.stock.code !== stockCode) {
      return { ok: false, message: "最近一次研究不是这只股票。" };
    }
    return jsonResult({
      ok: true,
      stock: research.stock,
      generatedAt: research.generatedAt,
      profile: research.profile,
      quote: research.quote,
      ratios: research.ratios,
      drawdowns: research.drawdowns,
      holders: research.holders,
      risks: research.risks,
      failures: research.failures,
      evidenceCount: research.evidence.length,
    });
  },
});

function jsonResult(value: unknown): { [key: string]: ToolResultValue } {
  return JSON.parse(JSON.stringify(value)) as { [key: string]: ToolResultValue };
}

async function readResearch(): Promise<AnalysisResult | null> {
  try {
    return JSON.parse(await readFile(latestResearchPath, "utf8")) as AnalysisResult;
  } catch {
    return null;
  }
}
