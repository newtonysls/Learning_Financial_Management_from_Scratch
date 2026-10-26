import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseLocalDocument } from "../src/server/documents/parser";
import { EvidenceStore } from "../src/server/evidence/evidence-store";
import { fetchAnnouncements } from "../src/server/sources/cninfo";
import {
  fetchCompanyProfile,
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

    await expect(fetchCompanyProfile(stock)).resolves.toEqual({
      stock,
      name: "贵州茅台",
      industry: "白酒",
      latestPrice: 1501.23,
      marketCapitalization: 1888123000000,
      sourceUrl: expect.stringMatching(
        /^https:\/\/push2\.eastmoney\.com\//,
      ),
      retrievedAt: expect.any(String),
    });
    await expect(fetchPriceHistory(stock, 3)).resolves.toEqual([
      { date: "2026-10-22", close: 1490.5 },
      { date: "2026-10-23", close: 1502.25 },
      { date: "2026-10-26", close: 1488 },
    ]);
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls.every((url) => url.startsWith("https://"))).toBe(
      true,
    );
    expect(requestedUrls[0]).toContain("secid=1.600519");
    expect(requestedUrls[1]).toContain("lmt=3");
  });

  test("normalizes CNInfo announcement links, dates, and categories", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          announcements: [
            {
              adjunctUrl: "finalpage/2026-10-20/1225000000.PDF",
              announcementId: "1225000000",
              announcementTitle: "<em>2025 年年度报告</em>",
              announcementTime: 1792454400000,
              secCode: "600519",
              secName: "贵州茅台",
              announcementTypeName: "年度报告",
            },
          ],
          totalAnnouncement: 1,
          totalpages: 1,
          hasMore: false,
        }),
      ),
    );

    const records = await fetchAnnouncements(stock);

    expect(records).toEqual([
      expect.objectContaining({
        id: "cninfo:1225000000",
        sourceGrade: "A",
        title: "2025 年年度报告",
        category: "年度报告",
        publishedAt: "2026-10-20T00:00:00.000Z",
        sourceUrl:
          "https://static.cninfo.com.cn/finalpage/2026-10-20/1225000000.PDF",
        retrievedAt: expect.any(String),
        contentHash: expect.any(String),
      }),
    ]);
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
      parseLocalDocument(textPath),
      parseLocalDocument(pdfPath),
      parseLocalDocument(workbookPath),
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

    await expect(parseLocalDocument(unsupportedPath)).rejects.toThrow(
      "file type",
    );
    await expect(parseLocalDocument(fakePdfPath)).rejects.toThrow("PDF");
    await expect(parseLocalDocument(largeTextPath)).rejects.toThrow(
      "file size",
    );
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
  });
}
