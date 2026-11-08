import { readFile } from "node:fs/promises";
import { defineTool, type ToolResultValue } from "@grok/agent-sdk";
import { z } from "zod";
import { searchEvidence } from "../../src/server/evidence/evidence-store";
import { latestResearchPath } from "../../src/server/paths";
import type { AnalysisResult } from "../../src/shared/types";

export default defineTool({
  description: "按关键词检索最近一次研究的公告、新闻、评论和本地文档证据。",
  effect: "read",
  inputSchema: z.object({ query: z.string().min(1) }),
  async execute({ query }): Promise<{ [key: string]: ToolResultValue }> {
    try {
      const research = JSON.parse(await readFile(latestResearchPath, "utf8")) as AnalysisResult;
      const matches = searchEvidence(research.evidence, query).slice(0, 8).map((item) => ({
        id: item.id,
        source: item.source,
        sourceGrade: item.sourceGrade,
        title: item.title,
        publishedAt: item.publishedAt,
        url: item.url,
        summary: item.summary,
      }));
      return JSON.parse(JSON.stringify({ ok: true, count: matches.length, matches })) as { [key: string]: ToolResultValue };
    } catch {
      return { ok: false, count: 0, matches: [] as ToolResultValue[] };
    }
  },
});
