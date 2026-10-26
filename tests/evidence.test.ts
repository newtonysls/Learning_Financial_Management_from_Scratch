import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseLocalDocument } from "../src/server/documents/parser";
import { EvidenceStore } from "../src/server/evidence/evidence-store";
import { fetchAnnouncements } from "../src/server/sources/cninfo";
import {
  fetchCompanyProfile,
  fetchFinancials,
  fetchPriceHistory,
} from "../src/server/sources/eastmoney";
import { safeFetchJson } from "../src/server/sources/http";

const stock = {
  code: "600519",
  exchange: "SH" as const,
  canonical: "600519.SH",
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("EvidenceStore", () => {
  test("deduplicates evidence and keeps the stronger source", () => {
    const store = new EvidenceStore(() => "2026-10-26T12:00:00.000Z");
    store.add({
      id: "a",
      sourceGrade: "C",
      title: "年报",
      contentHash: "same",
    });
    store.add({
      id: "b",
      sourceGrade: "A",
      title: "年报",
      contentHash: "same",
    });

    expect(store.list()).toEqual([
      expect.objectContaining({
        id: "b",
        retrievedAt: "2026-10-26T12:00:00.000Z",
      }),
    ]);
  });

  test("rejects invalid source grades and returns defensive copies", () => {
    const store = new EvidenceStore();
    expect(() =>
      store.add({
        id: "bad",
        sourceGrade: "Z" as "A",
        title: "不可信来源",
        contentHash: "bad",
      }),
    ).toThrow("source grade");

    store.add({
      id: "valid",
      sourceGrade: "B",
      title: "公告",
      contentHash: "valid",
    });
    const first = store.list();
    first.length = 0;
    expect(store.list()).toHaveLength(1);
  });
});

describe("safeFetchJson", () => {
  test("rejects non-HTTPS and private destinations before fetching", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      safeFetchJson("http://example.com/data", { fetchImpl }),
    ).rejects.toThrow("HTTPS");
    await expect(
      safeFetchJson("https://127.0.0.1/data", { fetchImpl }),
    ).rejects.toThrow("private");
    await expect(
      safeFetchJson("https://[::1]/data", { fetchImpl }),
    ).rejects.toThrow("private");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("caps retries at two and rejects oversized responses", async () => {
    const unavailable = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("busy", { status: 503 }));

    await expect(
      safeFetchJson("https://api.example.com/data", {
        allowedHosts: ["api.example.com"],
        fetchImpl: unavailable,
        maxRetries: 50,
      }),
    ).rejects.toThrow("503");
    expect(unavailable).toHaveBeenCalledTimes(3);

    const oversized = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"payload":"too large"}', {
        headers: { "content-length": "23" },
      }),
    );
    await expect(
      safeFetchJson("https://api.example.com/data", {
        allowedHosts: ["api.example.com"],
        fetchImpl: oversized,
        maxResponseBytes: 8,
      }),
    ).rejects.toThrow("response body");
    expect(oversized).toHaveBeenCalledTimes(1);
  });

  test("aborts requests at the configured bounded timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    });

    await expect(
      safeFetchJson("https://api.example.com/data", {
        allowedHosts: ["api.example.com"],
        fetchImpl,
        maxRetries: 0,
        timeoutMs: 5,
      }),
    ).rejects.toThrow("timed out");
  });

  test("backs off exponentially and respects Retry-After", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("busy", {
          status: 429,
          headers: { "retry-after": "2" },
        }),
      )
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(
      async () => undefined,
    );

    await expect(
      safeFetchJson("https://api.example.com/data", {
        allowedHosts: ["api.example.com"],
        fetchImpl,
        sleep,
      }),
    ).resolves.toEqual({ ok: true });
    expect(sleep.mock.calls).toEqual([[2_000], [500]]);
  });
});

describe("public source adapters", () => {
  test("normalizes Eastmoney quote and history fixtures with HTTPS source URLs", async () => {
    const quote = await readFixture("eastmoney-quote.json");
    const history = await readFixture("eastmoney-history.json");
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const url = String(input);
        requestedUrls.push(url);
        return Promise.resolve(
          Response.json(url.includes("/stock/get") ? quote : history),
        );
      }),
    );

    await expect(fetchCompanyProfile(stock)).resolves.toEqual(
      expect.objectContaining({
        stock,
        name: "贵州茅台",
        industry: "白酒",
        latestPrice: 1501.23,
        marketCapitalization: 1888123000000,
        sourceUrl: expect.stringMatching(
          /^https:\/\/push2\.eastmoney\.com\//,
        ),
        retrievedAt: expect.any(String),
        evidence: expect.objectContaining({
          id: expect.stringMatching(/^eastmoney:profile:/),
          sourceGrade: "C",
        }),
      }),
    );
    await expect(fetchPriceHistory(stock, 3)).resolves.toEqual([
      expect.objectContaining({
        date: "2026-10-22",
        close: 1490.5,
        evidence: expect.objectContaining({
          id: expect.stringMatching(/^eastmoney:prices:/),
        }),
      }),
      expect.objectContaining({ date: "2026-10-23", close: 1502.25 }),
      expect.objectContaining({ date: "2026-10-26", close: 1488 }),
    ]);
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls.every((url) => url.startsWith("https://"))).toBe(
      true,
    );
    expect(requestedUrls[0]).toContain("secid=1.600519");
    expect(requestedUrls[1]).toContain("lmt=3");
  });

  test("joins real Eastmoney statement snapshots without mixing accounting fields", async () => {
    const balance = await readFixture("eastmoney-balance.json");
    const income = await readFixture("eastmoney-income.json");
    const cashflow = await readFixture("eastmoney-cashflow.json");
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const url = String(input);
        requestedUrls.push(url);
        const fixture = url.includes("GBALANCE")
          ? balance
          : url.includes("GINCOME")
            ? income
            : cashflow;
        return Promise.resolve(Response.json(fixture));
      }),
    );

    const snapshots = await fetchFinancials(stock);

    expect(snapshots).toHaveLength(4);
    expect(snapshots.map((item) => item.reportDate)).toEqual([
      "2026-06-30",
      "2026-03-31",
      "2025-12-31",
      "2025-09-30",
    ]);
    expect(snapshots[0]).toEqual(
      expect.objectContaining({
        reportType: "中报",
        periodScope: "year-to-date",
        annualized: false,
        currency: "CNY",
        totalAssets: 309050784569.31,
        totalLiabilities: 46954432394.95,
        currentAssets: 260724668103.4,
        inventory: 61317208371.3,
        currentLiabilities: 46645073675.32,
        revenue: 92278072083.21,
        costOfRevenue: 9473762565.88,
        netIncome: 44516880421.86,
        operatingCashFlow: 70690750119.06,
        equity: 251253594419.5,
        interestExpense: 21034591.16,
        earningsBeforeInterestAndTax: 61459453768.45,
        interestExpenseBasis: "FE_INTEREST_EXPENSE",
        evidence: expect.objectContaining({
          id: "eastmoney:financial:600519.SH:2026-06-30",
          sourceGrade: "C",
        }),
      }),
    );
    expect(requestedUrls).toHaveLength(3);
    expect(
      requestedUrls.every((url) =>
        url.startsWith(
          "https://datacenter.eastmoney.com/securities/api/data/get",
        ),
      ),
    ).toBe(true);
  });

  test("fails loudly when an Eastmoney statement contract changes", async () => {
    const balance = structuredClone(
      await readFixture("eastmoney-balance.json"),
    ) as {
      result: { data: Array<Record<string, unknown>> };
    };
    for (const row of balance.result.data) {
      delete row.TOTAL_CURRENT_ASSETS;
    }
    const income = await readFixture("eastmoney-income.json");
    const cashflow = await readFixture("eastmoney-cashflow.json");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const url = String(input);
        return Promise.resolve(
          Response.json(
            url.includes("GBALANCE")
              ? balance
              : url.includes("GINCOME")
                ? income
                : cashflow,
          ),
        );
      }),
    );

    await expect(fetchFinancials(stock)).rejects.toThrow(
      "contract",
    );
  });

  test("uses CNInfo orgId and normalizes its real response snapshot", async () => {
    const organizations = await readFixture("cninfo-org.json");
    const announcements = structuredClone(
      await readFixture("cninfo-announcements.json"),
    ) as {
      announcements: Array<Record<string, unknown>>;
    };
    announcements.announcements.push({
      ...announcements.announcements[0],
      secCode: "000001",
      announcementId: "foreign-code",
    });
    announcements.announcements.push({
      ...announcements.announcements[0],
      orgId: "gssh0600000",
      announcementId: "foreign-org",
    });
    const requests: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const url = String(input);
        requests.push({ url, body: String(init?.body ?? "") });
        return Promise.resolve(
          Response.json(
            url.includes("/topSearch/") ? organizations : announcements,
          ),
        );
      }),
    );

    const records = await fetchAnnouncements(stock);

    expect(records).toHaveLength(3);
    expect(records[0]).toEqual(
      expect.objectContaining({
        id: "cninfo:1225475868",
        sourceGrade: "A",
        title: "贵州茅台2026年半年度报告",
        category: "01010503||010113||010303",
        publishedAt: "2026-08-15T00:00:00.000Z",
        sourceUrl:
          "https://static.cninfo.com.cn/finalpage/2026-08-15/1225475868.PDF",
        retrievedAt: expect.any(String),
        contentHash: expect.any(String),
      }),
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toContain("/topSearch/query");
    expect(requests[1]?.body).toContain(
      "stock=600519%2Cgssh0600519",
    );
    expect(
      records.some((record) => record.id.startsWith("cninfo:foreign")),
    ).toBe(false);
  });

  test("all public adapters reject non-A-share or inconsistent StockId values", async () => {
    const invalidStocks = [
      { code: "510300", exchange: "SH" as const, canonical: "510300.SH" },
      { code: "600519", exchange: "SH" as const, canonical: "000001.SZ" },
    ];
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    for (const invalidStock of invalidStocks) {
      await expect(fetchCompanyProfile(invalidStock)).rejects.toThrow();
      await expect(fetchPriceHistory(invalidStock, 3)).rejects.toThrow();
      await expect(fetchFinancials(invalidStock)).rejects.toThrow();
      await expect(fetchAnnouncements(invalidStock)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("parseLocalDocument", () => {
  test("parses text, PDF pages, and XLSX sheets with locators", async () => {
    const directory = await makeTemporaryDirectory();
    const textPath = path.join(directory, "notes.md");
    const pdfPath = path.join(directory, "report.pdf");
    const workbookPath = path.join(directory, "metrics.xlsx");
    await writeFile(textPath, "# 调研笔记\n收入稳定", "utf8");
    await writeFile(pdfPath, createPdf("Annual Report"));
    await writeFile(workbookPath, createXlsx("指标", [["收入", "100"]]));

    const [text, pdf, workbook] = await Promise.all([
      parseLocalDocument(textPath, { knowledgeBaseRoot: directory }),
      parseLocalDocument(pdfPath, { knowledgeBaseRoot: directory }),
      parseLocalDocument(workbookPath, { knowledgeBaseRoot: directory }),
    ]);

    expect(text).toEqual([
      expect.objectContaining({
        sourceGrade: "D",
        content: "# 调研笔记\n收入稳定",
        locator: { lineStart: 1, lineEnd: 2 },
        retrievedAt: expect.any(String),
      }),
    ]);
    expect(pdf).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("Annual Report"),
        locator: { page: 1 },
      }),
    ]);
    expect(workbook).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("收入,100"),
        locator: { sheet: "指标" },
      }),
    ]);
  });

  test("rejects unsupported, mismatched, and oversized local files", async () => {
    const directory = await makeTemporaryDirectory();
    const unsupportedPath = path.join(directory, "script.js");
    const fakePdfPath = path.join(directory, "fake.pdf");
    const largeTextPath = path.join(directory, "large.txt");
    await writeFile(unsupportedPath, "alert(1)", "utf8");
    await writeFile(fakePdfPath, "not a pdf", "utf8");
    await writeFile(largeTextPath, Buffer.alloc(10 * 1024 * 1024 + 1));

    const options = { knowledgeBaseRoot: directory };
    await expect(
      parseLocalDocument(unsupportedPath, options),
    ).rejects.toThrow("file type");
    await expect(parseLocalDocument(fakePdfPath, options)).rejects.toThrow(
      "PDF",
    );
    await expect(
      parseLocalDocument(largeTextPath, options),
    ).rejects.toThrow("file size");
  });

  test("confines reads to the real knowledge root and rejects symlinks", async () => {
    const root = await makeTemporaryDirectory();
    const outside = await makeTemporaryDirectory();
    const outsidePath = path.join(outside, "outside.txt");
    const linkedPath = path.join(root, "linked.txt");
    await writeFile(outsidePath, "outside", "utf8");
    await symlink(outsidePath, linkedPath);

    await expect(
      parseLocalDocument(outsidePath, { knowledgeBaseRoot: root }),
    ).rejects.toThrow("knowledge base");
    await expect(
      parseLocalDocument(linkedPath, { knowledgeBaseRoot: root }),
    ).rejects.toThrow("symbolic");
    await expect(parseLocalDocument(outsidePath)).rejects.toThrow(
      "knowledge base root",
    );
  });

  test("decodes HTML entities once and marks extracted content as plain text", async () => {
    const directory = await makeTemporaryDirectory();
    const htmlPath = path.join(directory, "note.html");
    await writeFile(
      htmlPath,
      "<p>&amp;lt;script&amp;gt;</p><b>safe</b>",
      "utf8",
    );

    const records = await parseLocalDocument(htmlPath, {
      knowledgeBaseRoot: directory,
    });

    expect(records[0]).toEqual(
      expect.objectContaining({
        content: "&lt;script&gt; safe",
        contentType: "text/plain",
      }),
    );
  });

  test("measures actual XLSX expansion instead of trusting ZIP metadata", async () => {
    const directory = await makeTemporaryDirectory();
    const workbookPath = path.join(directory, "bomb.xlsx");
    const workbook = createXlsx(
      "指标",
      [["收入", "100"]],
      { "xl/media/padding.bin": Buffer.alloc(51 * 1024 * 1024) },
    );
    await writeFile(workbookPath, underreportExpandedSizes(workbook));

    await expect(
      parseLocalDocument(workbookPath, {
        knowledgeBaseRoot: directory,
      }),
    ).rejects.toThrow("expanded content");
  });
});

async function readFixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL(`./fixtures/${name}`, import.meta.url),
      "utf8",
    ),
  ) as unknown;
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "evidence-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createPdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length + 33} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

function createXlsx(
  sheetName: string,
  rows: string[][],
  extraEntries: Record<string, Uint8Array> = {},
): Uint8Array {
  const rowXml = rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">${row
          .map(
            (cell, columnIndex) =>
              `<c r="${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${cell}</t></is></c>`,
          )
          .join("")}</row>`,
    )
    .join("");
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`,
    ),
    ...extraEntries,
  });
}

function underreportExpandedSizes(archive: Uint8Array): Buffer {
  const bytes = Buffer.from(archive);
  for (let offset = 0; offset <= bytes.length - 30; offset += 1) {
    const signature = bytes.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      bytes.writeUInt32LE(1, offset + 22);
    } else if (signature === 0x02014b50) {
      bytes.writeUInt32LE(1, offset + 24);
    }
  }
  return bytes;
}
