import type { EvidenceStore } from "../evidence/evidence-store";
import type { StockId } from "../../shared/types";
import { civilDate } from "../analysis/dates";
import { excerpt, sha256 } from "../analysis/text";
import type { SafeClient } from "./http";
import { http } from "./http";

interface OrgCache {
  at: number;
  rows: Map<string, { orgId: string; category: string }>;
}

let orgCache: OrgCache | undefined;

export function clearOrgCache(): void {
  orgCache = undefined;
}

export async function fetchAnnouncements(
  stock: StockId,
  input: { client?: SafeClient; store: EvidenceStore; retrievedAt: string },
): Promise<void> {
  const client = input.client ?? http;
  const orgId = await findOrgId(stock, client);
  const body = new URLSearchParams({
    stock: `${stock.code},${orgId}`,
    tabName: "fulltext",
    pageSize: "20",
    pageNum: "1",
    column: stock.exchange === "SH" ? "sse" : "szse",
    plate: stock.exchange === "SH" ? "sh" : "sz",
    isHLtitle: "true",
  }).toString();
  const response = await client.post("https://www.cninfo.com.cn/new/hisAnnouncement/query", body, {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      referer: `https://www.cninfo.com.cn/new/disclosure/stock?stockCode=${stock.code}&orgId=${orgId}`,
    },
    maxBytes: 3_000_000,
  });
  const payload = parseJson(response.body.toString("utf8"));
  if (!Array.isArray(payload.announcements)) throw new Error("巨潮公告响应缺少 announcements");
  const matches = payload.announcements.filter((item): item is Record<string, unknown> => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    return row.secCode === stock.code && row.orgId === orgId;
  });
  for (const row of matches) {
    const title = typeof row.announcementTitle === "string" ? row.announcementTitle : "未命名公告";
    const adjunct = typeof row.adjunctUrl === "string" ? row.adjunctUrl : "";
    const category = typeof row.announcementType === "string" && row.announcementType
      ? row.announcementType
      : "未分类";
    const publishedAt = typeof row.announcementTime === "number"
      ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(row.announcementTime))
      : null;
    input.store.add({
      source: "巨潮资讯",
      sourceGrade: "A",
      title,
      url: adjunct ? `https://static.cninfo.com.cn/${adjunct}` : "https://www.cninfo.com.cn/",
      publisher: "巨潮资讯",
      publishedAt,
      retrievedAt: input.retrievedAt,
      reportPeriod: publishedAt ? civilDate(publishedAt) : null,
      summary: excerpt(`${title}；公告分类代码 ${category}`),
      contentHash: sha256(`${stock.canonical}|${adjunct}|${title}`),
      locator: null,
      category,
      sentiment: null,
    });
  }
}

async function findOrgId(stock: StockId, client: SafeClient): Promise<string> {
  if (!orgCache || Date.now() - orgCache.at > 12 * 60 * 60 * 1000) {
    const response = await client.get("https://www.cninfo.com.cn/new/data/szse_stock.json", { maxBytes: 15_000_000 });
    const payload = parseJson(response.body.toString("utf8"));
    const list = Array.isArray(payload.stockList) ? payload.stockList : [];
    const rows = new Map<string, { orgId: string; category: string }>();
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (typeof row.code === "string" && typeof row.orgId === "string") {
        rows.set(row.code, { orgId: row.orgId, category: typeof row.category === "string" ? row.category : "" });
      }
    }
    orgCache = { at: Date.now(), rows };
  }
  const found = orgCache.rows.get(stock.code);
  if (!found || !found.category.includes("A股")) throw new Error("未在巨潮 A 股列表找到该证券");
  return found.orgId;
}

function parseJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("巨潮响应不是 JSON 对象");
  return parsed as Record<string, unknown>;
}
