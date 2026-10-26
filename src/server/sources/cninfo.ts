import type {
  EvidenceRecord,
  StockId,
} from "../../shared/types";
import { hashContent } from "../evidence/evidence-store";
import { safeFetchJson } from "./http";

const QUERY_HOST = "www.cninfo.com.cn";
const DOCUMENT_HOST = "static.cninfo.com.cn";
const QUERY_URL = `https://${QUERY_HOST}/new/hisAnnouncement/query`;

interface CninfoResponse {
  announcements?: unknown;
}

interface CninfoAnnouncement {
  adjunctUrl?: unknown;
  announcementId?: unknown;
  announcementTitle?: unknown;
  announcementTime?: unknown;
  announcementTypeName?: unknown;
}

export async function fetchAnnouncements(
  stock: StockId,
): Promise<EvidenceRecord[]> {
  assertStock(stock);
  const form = new URLSearchParams({
    pageNum: "1",
    pageSize: "30",
    column: stock.exchange === "SH" ? "sse" : "szse",
    tabName: "fulltext",
    plate: "",
    stock: stock.code,
    searchkey: "",
    secid: "",
    category: "",
    trade: "",
    seDate: "",
    sortName: "",
    sortType: "",
    isHLtitle: "true",
  });
  const response = await safeFetchJson<CninfoResponse>(QUERY_URL, {
    allowedHosts: [QUERY_HOST],
    request: {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        origin: "https://www.cninfo.com.cn",
        referer: "https://www.cninfo.com.cn/",
      },
      body: form,
    },
  });
  if (!Array.isArray(response.announcements)) {
    throw new Error("CNInfo response has no announcements");
  }

  const retrievedAt = new Date().toISOString();
  return response.announcements.flatMap((raw): EvidenceRecord[] => {
    if (!isRecord(raw)) {
      return [];
    }
    const announcement = raw as CninfoAnnouncement;
    const title = cleanTitle(announcement.announcementTitle);
    const sourceUrl = normalizeDocumentUrl(announcement.adjunctUrl);
    const publishedAt = normalizeTimestamp(
      announcement.announcementTime,
    );
    if (!title || !sourceUrl || !publishedAt) {
      return [];
    }
    const announcedId = toNonEmptyText(
      announcement.announcementId,
    );
    const contentHash = hashContent(sourceUrl);

    return [
      {
        id: `cninfo:${announcedId ?? contentHash}`,
        sourceGrade: "A",
        title,
        contentHash,
        sourceUrl,
        publishedAt,
        retrievedAt,
        category:
          toNonEmptyText(announcement.announcementTypeName) ??
          undefined,
      },
    ];
  });
}

function normalizeDocumentUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^finalpage\/[\w./-]+$/i.test(value)
  ) {
    return null;
  }
  const url = new URL(value, `https://${DOCUMENT_HOST}/`);
  return url.protocol === "https:" && url.hostname === DOCUMENT_HOST
    ? url.toString()
    : null;
}

function cleanTitle(value: unknown): string | null {
  const title = toNonEmptyText(value);
  if (!title) {
    return null;
  }
  const clean = title
    .replace(/<[^>]*>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .trim();
  return clean || null;
}

function normalizeTimestamp(value: unknown): string | null {
  const milliseconds =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNonEmptyText(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const text = String(value).trim();
  return text || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertStock(stock: StockId): void {
  if (
    !/^\d{6}$/.test(stock.code) ||
    (stock.exchange !== "SH" && stock.exchange !== "SZ")
  ) {
    throw new Error("invalid stock identifier");
  }
}
