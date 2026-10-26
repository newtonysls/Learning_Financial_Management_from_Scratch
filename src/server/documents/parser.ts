import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Unzip, UnzipInflate } from "fflate";
import readXlsxFile from "read-excel-file/node";
import type { EvidenceRecord } from "../../shared/types";
import { hashContent } from "../evidence/evidence-store";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_PDF_PAGES = 2_000;
const MAX_SHEET_ROWS = 100_000;
const DEFAULT_PDF_TIMEOUT_MS = 10_000;
const MAX_PDF_TIMEOUT_MS = 12_000;
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".csv",
  ".html",
  ".htm",
]);

export async function parseLocalDocument(
  file: string,
  options: ParseLocalDocumentOptions = {},
): Promise<EvidenceRecord[]> {
  const filePath = await resolveKnowledgeBaseFile(file, options);
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let bytes: Buffer;
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error("local document must be a regular file");
    }
    if (fileStat.size > MAX_FILE_BYTES) {
      throw new Error("local document file size exceeds 10 MiB");
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }

  const extension = path.extname(filePath).toLowerCase();
  if (
    extension !== ".pdf" &&
    extension !== ".xlsx" &&
    !TEXT_EXTENSIONS.has(extension)
  ) {
    throw new Error("unsupported local document file type");
  }

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
    return parsePdf(
      bytes,
      context,
      boundedPdfTimeout(options.pdfTimeoutMs),
    );
  }
  if (extension === ".xlsx") {
    return parseWorkbook(bytes, context);
  }
  return parseText(bytes, extension, context);
}

export interface ParseLocalDocumentOptions {
  knowledgeBaseRoot?: string;
  pdfTimeoutMs?: number;
}

async function resolveKnowledgeBaseFile(
  file: string,
  options: ParseLocalDocumentOptions,
): Promise<string> {
  const configuredRoot =
    options.knowledgeBaseRoot ?? process.env.KNOWLEDGE_BASE_ROOT;
  if (!configuredRoot) {
    throw new Error("knowledge base root is not configured");
  }
  const rootPath = path.resolve(configuredRoot);
  const rootStat = await lstat(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(
      "knowledge base root must be a real directory without symbolic links",
    );
  }
  const realRoot = await realpath(rootPath);
  if (realRoot !== rootPath) {
    throw new Error("knowledge base root cannot contain symbolic links");
  }

  const requestedPath = path.resolve(file);
  assertContainedPath(realRoot, requestedPath);
  const relativeParts = path.relative(realRoot, requestedPath).split(
    path.sep,
  );
  let currentPath = realRoot;
  for (const part of relativeParts) {
    currentPath = path.join(currentPath, part);
    const currentStat = await lstat(currentPath);
    if (currentStat.isSymbolicLink()) {
      throw new Error(
        "symbolic links are not allowed in the knowledge base",
      );
    }
  }

  const realFile = await realpath(requestedPath);
  assertContainedPath(realRoot, realFile);
  return realFile;
}

function assertContainedPath(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  ) {
    return;
  }
  throw new Error("local document is outside the knowledge base root");
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
  timeoutMs: number,
): Promise<EvidenceRecord[]> {
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("PDF file signature does not match its file type");
  }
  let cancelPdf: (() => Promise<void>) | undefined;
  let timeoutTriggered = false;
  const parsing = (async () => {
    const { getDocument } = await import(
      "pdfjs-dist/legacy/build/pdf.mjs"
    );
    const documentOptions = {
      data: new Uint8Array(bytes),
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: false,
      useWasm: false,
    } as Parameters<typeof getDocument>[0] & {
      isEvalSupported: false;
    };
    const loadingTask = getDocument(documentOptions);
    let destroyed = false;
    cancelPdf = async () => {
      if (!destroyed) {
        destroyed = true;
        await loadingTask.destroy();
      }
    };
    if (timeoutTriggered) {
      await cancelPdf();
    }
    const document = await loadingTask.promise;
    try {
      if (document.numPages > MAX_PDF_PAGES) {
        throw new Error("PDF page count exceeds the allowed limit");
      }
      const records: EvidenceRecord[] = [];
      let extractedBytes = 0;
      for (
        let pageNumber = 1;
        pageNumber <= document.numPages;
        pageNumber += 1
      ) {
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
          throw new Error(
            "PDF extracted text exceeds the allowed size",
          );
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
      await cancelPdf();
    }
  })();
  return withTimeout(parsing, timeoutMs, async () => {
    timeoutTriggered = true;
    await cancelPdf?.();
  });
}

async function parseWorkbook(
  bytes: Buffer,
  context: DocumentContext,
): Promise<EvidenceRecord[]> {
  await validateXlsxArchive(bytes);
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
    contentType: "text/plain",
    contentHash,
    sourceUrl: context.sourceUrl,
    retrievedAt: context.retrievedAt,
    locator,
  };
}

async function validateXlsxArchive(bytes: Buffer): Promise<void> {
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
  await verifyActualZipExpansion(bytes);
}

function verifyActualZipExpansion(bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    let expandedBytes = 0;
    let pendingFiles = 0;
    let inputComplete = false;
    let settled = false;
    const finishIfComplete = () => {
      if (!settled && inputComplete && pendingFiles === 0) {
        settled = true;
        resolve();
      }
    };
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const unzip = new Unzip((file) => {
      pendingFiles += 1;
      file.ondata = (error, chunk, final) => {
        if (settled) {
          file.terminate?.();
          return;
        }
        if (error) {
          fail(new Error("XLSX ZIP data is invalid"));
          return;
        }
        expandedBytes += chunk.byteLength;
        if (expandedBytes > MAX_EXPANDED_BYTES) {
          file.terminate?.();
          fail(
            new Error(
              "XLSX expanded content exceeds the allowed size",
            ),
          );
          return;
        }
        if (final) {
          pendingFiles -= 1;
          finishIfComplete();
        }
      };
      try {
        file.start();
      } catch {
        fail(new Error("XLSX ZIP compression is unsupported"));
      }
    });
    unzip.register(UnzipInflate);
    try {
      const chunkSize = 64 * 1024;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        if (settled) {
          break;
        }
        const end = Math.min(offset + chunkSize, bytes.length);
        unzip.push(bytes.subarray(offset, end), end === bytes.length);
      }
      inputComplete = true;
      finishIfComplete();
    } catch {
      fail(new Error("XLSX ZIP data is invalid"));
    }
  });
}

function boundedPdfTimeout(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_PDF_TIMEOUT_MS;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("PDF timeout must be a positive finite number");
  }
  return Math.min(Math.trunc(value), MAX_PDF_TIMEOUT_MS);
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void onTimeout().finally(() => {
        reject(new Error(`PDF parsing timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
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
    .replace(
      /&(nbsp|amp|lt|gt|quot|#39);/g,
      (entity): string =>
        ({
          "&nbsp;": " ",
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&#39;": "'",
        })[entity] ?? entity,
    )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}
