import type { EvidenceStore } from "../evidence/evidence-store";
import { classifySentiment, excerpt, sha256, stripHtml } from "../analysis/text";
import type { SafeClient } from "./http";
import { http } from "./http";

export async function fetchOfficialSite(
  website: string,
  input: { client?: SafeClient; store: EvidenceStore; retrievedAt: string },
): Promise<void> {
  const response = await (input.client ?? http).get(website, { mode: "public-web", maxBytes: 1_000_000 });
  const html = response.body.toString("utf8");
  if (/安全验证|访问验证|captcha/i.test(html)) throw new Error("官网返回访问验证，未绕过");
  const title = excerpt(stripHtml(match(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? ""), 120);
  const description = excerpt(stripHtml(matchAttribute(html, "description") ?? stripHtml(html).slice(0, 300)), 400);
  if (!title && !description) throw new Error("官网没有可提取的公开介绍");
  input.store.add({
    source: "公司官网",
    sourceGrade: "A",
    title: title || "公司官网",
    url: website,
    publisher: "公司官网",
    publishedAt: null,
    retrievedAt: input.retrievedAt,
    reportPeriod: null,
    summary: description,
    contentHash: sha256(`website|${website}|${title}|${description}`),
    locator: null,
    category: "官网",
    sentiment: null,
  });
}

export async function fetchBaike(
  name: string,
  input: { client?: SafeClient; store: EvidenceStore; retrievedAt: string },
): Promise<void> {
  const url = `https://baike.baidu.com/item/${encodeURIComponent(name)}`;
  const response = await (input.client ?? http).get(url, { mode: "public-web", maxBytes: 1_500_000 });
  const html = response.body.toString("utf8");
  if (/安全验证|百度安全|wappass/i.test(html)) throw new Error("百度百科返回访问验证，未绕过");
  const description = excerpt(stripHtml(matchAttribute(html, "description") ?? ""), 500);
  if (!description) throw new Error("百度百科没有返回可引用的摘要");
  input.store.add({
    source: "百度百科",
    sourceGrade: "C",
    title: `${name} 百科词条`,
    url,
    publisher: "百度百科",
    publishedAt: null,
    retrievedAt: input.retrievedAt,
    reportPeriod: null,
    summary: description,
    contentHash: sha256(`baike|${name}|${description}`),
    locator: null,
    category: "背景资料",
    sentiment: classifySentiment(description),
  });
}

function match(value: string, pattern: RegExp): string | undefined {
  return pattern.exec(value)?.[1];
}

function matchAttribute(html: string, name: string): string | undefined {
  const pattern = new RegExp(`<meta[^>]*(?:name|property)=["']${name}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i");
  const reverse = new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']${name}["'][^>]*>`, "i");
  return pattern.exec(html)?.[1] ?? reverse.exec(html)?.[1];
}
