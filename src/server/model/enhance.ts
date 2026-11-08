import type { ResearchPackage } from "../../shared/types";
import { redactSecrets } from "../analysis/text";
import { validateCitations } from "../report/citations";
import { createHttpClient } from "../sources/http";

export async function enhanceReport(markdown: string, pkg: ResearchPackage): Promise<{ markdown: string; mode: "deterministic" | "model" }> {
  const baseUrl = process.env.OPENAI_COMPAT_BASE_URL;
  const apiKey = process.env.OPENAI_COMPAT_API_KEY;
  const model = process.env.OPENAI_COMPAT_MODEL;
  if (!baseUrl || !apiKey || !model) return { markdown, mode: "deterministic" };
  try {
    const endpoint = completionsUrl(baseUrl);
    const client = createHttpClient();
    const response = await client.post(endpoint, JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: "你只能润色已给出的中文研究报告。不得新增数字、日期、公司、客户、供应商或引用编号；必须保留全部原有 [E数字] 引用。" },
        { role: "user", content: markdown },
      ],
    }), {
      mode: "public-web",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      maxBytes: 2_000_000,
      retries: 0,
    });
    const payload = JSON.parse(response.body.toString("utf8")) as { choices?: Array<{ message?: { content?: string } }> };
    const revised = payload.choices?.[0]?.message?.content;
    if (!revised || !validateCitations(revised, pkg.evidence).valid || !sameCitations(markdown, revised)) {
      return { markdown, mode: "deterministic" };
    }
    return { markdown: revised, mode: "model" };
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : "模型调用失败");
    return { markdown: `${markdown}\n\n模型润色未采用：${message}`, mode: "deterministic" };
  }
}

function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function sameCitations(original: string, revised: string): boolean {
  return citationSet(original) === citationSet(revised);
}

function citationSet(markdown: string): string {
  return [...markdown.matchAll(/\[(E\d+)\]/g)].map((match) => match[1]).sort().join(",");
}
