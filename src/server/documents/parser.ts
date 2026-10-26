import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import readXlsxFile from "read-excel-file/node";
import type { EvidenceRecord } from "../../shared/types";
import { hashContent } from "../evidence/evidence-store";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_PDF_PAGES = 2_000;
const MAX_SHEET_ROWS = 100_000;
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".csv",
  ".html",
  ".htm",
]);

export async function parseLocalDocument(
  file: string,
): Promise<EvidenceRecord[]> {
  const filePath = path.resolve(file);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error("local document must be a regular file");
  }
  if (fileStat.size > MAX_FILE_BYTES) {
    throw new Error("local document file size exceeds 10 MiB");
  }

  const extension = path.extname(filePath).toLowerCase();
  if (
    extension !== ".pdf" &&
    extension !== ".xlsx" &&
    !TEXT_EXTENSIONS.has(extension)
  ) {
    throw new Error("unsupported local document file type");
  }

  const bytes = await readFile(filePath);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error("local document file size exceeds 10 MiB");
  }

  const context = {
    filePath,
    title: path.basename(filePath),
    sourceUrl: pathToFileURL(filePath).href,
    retrievedAt: new Date().toISOString(),
  };
  if (extension === ".pdf") {
    return parsePdf(bytes, context);
  }
  if (extension === ".xlsx") {
    return parseWorkbook(bytes, context);
  }
  return parseText(bytes, extension, context);
}

interface DocumentContext {
  filePath: string;
  title: string;
  sourceUrl: string;
  retrievedAt: string;
}

async function parsePdf(
  bytes: Buffer,
  context: DocumentContext,
): Promise<EvidenceRecord[]> {
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("PDF file signature does not match its file type");
  }
  const { getDocument } = await import(
    "pdfjs-dist/legacy/build/pdf.mjs"
  );
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  try {
    if (document.numPages > MAX_PDF_PAGES) {
      throw new Error("PDF page count exceeds the allowed limit");
    }
    const records: EvidenceRecord[] = [];
    let extractedBytes = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const content = textContent.items
        .flatMap((item) =>
          typeof item === "object" &&
          item !== null &&
          "str" in item &&
          typeof item.str === "string"
            ? [item.str]
            : [],
        )
        .join(" ")
        .trim();
      extractedBytes += Buffer.byteLength(content);
      if (extractedBytes > MAX_EXPANDED_BYTES) {
        throw new Error("PDF extracted text exceeds the allowed size");
      }
      if (content) {
        records.push(
          createRecord(context, content, {
            page: pageNumber,
          }),
        );
      }
      page.cleanup();
    }
    return records;
  } finally {
    await loadingTask.destroy();
  }
}

async function parseWorkbook(
  bytes: Buffer,
  context: DocumentContext,
): Promise<EvidenceRecord[]> {
  validateXlsxArchive(bytes);
  let sheets: Awaited<ReturnType<typeof readXlsxFile>>;
  try {
    sheets = await readXlsxFile(bytes);
  } catch {
    throw new Error("XLSX file structure is invalid");
  }
  if (sheets.length > 1_000) {
    throw new Error("XLSX sheet count exceeds the allowed limit");
  }

  const records: EvidenceRecord[] = [];
  let extractedBytes = 0;
  for (const { sheet, data: rows } of sheets) {
    if (rows.length > MAX_SHEET_ROWS) {
      throw new Error("XLSX row count exceeds the allowed limit");
    }
    const content = rows
      .map((row) =>
        row
          .map((cell) => csvCell(cell === null ? "" : String(cell)))
          .join(","),
      )
      .join("\n")
      .trim();
    extractedBytes += Buffer.byteLength(content);
    if (extractedBytes > MAX_EXPANDED_BYTES) {
      throw new Error("XLSX extracted text exceeds the allowed size");
    }
    if (content) {
      records.push(createRecord(context, content, { sheet }));
    }
  }
  return records;
}

function parseText(
  bytes: Buffer,
  extension: string,
  context: DocumentContext,
): EvidenceRecord[] {
  if (bytes.includes(0)) {
    throw new Error("text file content does not match its file type");
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("text file must use valid UTF-8");
  }
  if (extension === ".html" || extension === ".htm") {
    content = extractHtmlText(content);
  }
  content = content.replace(/^\uFEFF/, "").trim();
  if (!content) {
    return [];
  }
  const lineCount = content.split(/\r?\n/).length;
  return [
    createRecord(context, content, {
      lineStart: 1,
      lineEnd: lineCount,
    }),
  ];
}

function createRecord(
  context: DocumentContext,
  content: string,
  locator: EvidenceRecord["locator"],
): EvidenceRecord {
  const contentHash = hashContent(content);
  const locatorKey = JSON.stringify(locator);
  return {
    id: `local:${hashContent(
      `${context.sourceUrl}\n${locatorKey}\n${contentHash}`,
    )}`,
    sourceGrade: "D",
    title: context.title,
    content,
    contentHash,
    sourceUrl: context.sourceUrl,
    retrievedAt: context.retrievedAt,
    locator,
  };
}

function validateXlsxArchive(bytes: Buffer): void {
  if (
    bytes.byteLength < 4 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b
  ) {
    throw new Error("XLSX file signature does not match its file type");
  }
  const binary = bytes.toString("latin1");
  if (
    !binary.includes("[Content_Types].xml") ||
    !binary.includes("xl/workbook.xml")
  ) {
    throw new Error("XLSX file structure is invalid");
  }

  let entryCount = 0;
  let expandedBytes = 0;
  for (let offset = 0; offset <= bytes.length - 46; offset += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) {
      continue;
    }
    entryCount += 1;
    expandedBytes += bytes.readUInt32LE(offset + 24);
    if (
      entryCount > 1_000 ||
      expandedBytes > MAX_EXPANDED_BYTES
    ) {
      throw new Error("XLSX expanded content exceeds the allowed size");
    }
  }
  if (entryCount === 0) {
    throw new Error("XLSX central directory is missing");
  }
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

function extractHtmlText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}
