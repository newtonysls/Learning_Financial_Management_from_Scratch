import type {
  EvidenceRecord,
  StockId,
} from "../../shared/types";
import { assertStockId } from "../domain/stock-id";
import { hashContent } from "../evidence/evidence-store";
import { safeFetchJson } from "./http";

const QUERY_HOST = "www.cninfo.com.cn";
const DOCUMENT_HOST = "static.cninfo.com.cn";
const QUERY_URL = `https://${QUERY_HOST}/new/hisAnnouncement/query`;
const ORGANIZATION_URL = `https://${QUERY_HOST}/new/information/topSearch/query`;

interface CninfoResponse {
  announcements?: unknown;
}

interface CninfoAnnouncement {
  adjunctUrl?: unknown;
  announcementId?: unknown;
  announcementTitle?: unknown;
  announcementTime?: unknown;
  announcementType?: unknown;
  announcementTypeName?: unknown;
  columnId?: unknown;
  orgId?: unknown;
  pageColumn?: unknown;
  secCode?: unknown;
}

interface CninfoOrganization {
  category?: unknown;
  code?: unknown;
  orgId?: unknown;
  type?: unknown;
}

export async function fetchAnnouncements(
  stock: StockId,
): Promise<EvidenceRecord[]> {
  const normalizedStock = assertStockId(stock);
  const organization = await fetchOrganization(normalizedStock);
  const form = new URLSearchParams({
    pageNum: "1",
    pageSize: "30",
    column: normalizedStock.exchange === "SH" ? "sse" : "szse",
    tabName: "fulltext",
    plate: "",
    stock: `${normalizedStock.code},${organization.orgId}`,
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
  const matchingAnnouncements = response.announcements.filter((raw) => {
    if (!isRecord(raw)) {
      return false;
    }
    const secCode = toNonEmptyText(raw.secCode);
    const orgId = toNonEmptyText(raw.orgId);
    return (
      secCode === normalizedStock.code &&
      (orgId === null || orgId === organization.orgId)
    );
  });
  const records = matchingAnnouncements.flatMap(
    (raw): EvidenceRecord[] => {
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
          toNonEmptyText(announcement.announcementType) ??
          toNonEmptyText(announcement.columnId) ??
          toNonEmptyText(announcement.pageColumn) ??
          undefined,
      },
    ];
    },
  );
  if (matchingAnnouncements.length > 0 && records.length === 0) {
    throw new Error("CNInfo announcement source contract changed");
  }
  return records;
}

async function fetchOrganization(
  stock: StockId,
): Promise<{ orgId: string }> {
  const url = new URL(ORGANIZATION_URL);
  url.search = new URLSearchParams({
    keyWord: stock.code,
    maxNum: "10",
  }).toString();
  const response = await safeFetchJson<unknown>(url, {
    allowedHosts: [QUERY_HOST],
    request: {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        origin: "https://www.cninfo.com.cn",
        referer: "https://www.cninfo.com.cn/",
      },
    },
  });
  if (!Array.isArray(response)) {
    throw new Error("CNInfo organization source contract changed");
  }
  const organization = response.find((item) => {
    if (!isRecord(item)) {
      return false;
    }
    const type = toNonEmptyText(item.type);
    return (
      toNonEmptyText(item.code) === stock.code &&
      toNonEmptyText(item.category) === "A股" &&
      (type === null ||
        (stock.exchange === "SH"
          ? type.startsWith("sh")
          : !type.startsWith("sh")))
    );
  }) as CninfoOrganization | undefined;
  const orgId = toNonEmptyText(organization?.orgId);
  if (!orgId) {
    throw new Error("CNInfo organization lookup found no matching A-share");
  }
  return { orgId };
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
