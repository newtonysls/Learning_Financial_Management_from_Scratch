import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative } from "node:path";
import type { EvidenceDraft } from "../../shared/types";
import { excerpt, sha256, stripHtml } from "../analysis/text";
import { unzipLimited } from "./zip";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 20 * 1024 * 1024;

export async function parseLocalDocument(filePath: string, root: string, retrievedAt: string): Promise<EvidenceDraft[]> {
  const rootReal = await realpath(root);
  const linkStat = await lstat(filePath);
  if (linkStat.isSymbolicLink()) throw new Error("拒绝读取符号链接");
  if (!linkStat.isFile()) throw new Error("只能读取普通文件");
  if (linkStat.size > MAX_FILE_BYTES) throw new Error("文件超过 10MB 上限");
  const fileReal = await realpath(filePath);
  const rel = relative(rootReal, fileReal);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("文件不在知识库目录内");
  const extension = extname(fileReal).toLowerCase();
  const buffer = await readFile(fileReal);
  const name = basename(fileReal);
  if (extension === ".pdf") return pdfEvidence(buffer, name, retrievedAt);
  if (extension === ".xlsx") return xlsxEvidence(buffer, name, retrievedAt);
  if ([".txt", ".md", ".csv", ".html", ".htm"].includes(extension)) {
    return textEvidence(decodeUtf8(buffer), name, extension, retrievedAt);
  }
  throw new Error("仅支持 PDF、XLSX、TXT、Markdown、CSV 和 HTML");
}

async function pdfEvidence(buffer: Buffer, name: string, retrievedAt: string): Promise<EvidenceDraft[]> {
  if (!buffer.subarray(0, 5).toString("latin1").startsWith("%PDF")) throw new Error("PDF 文件签名不正确");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("PDF 解析超时")), 10_000);
    timer.unref?.();
  });
  const document = await Promise.race([task.promise, timeout]);
  try {
    const drafts: EvidenceDraft[] = [];
    const pageCount = Math.min(document.numPages, 30);
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => "str" in item ? item.str : "").join(" ").trim();
      if (!text) continue;
      drafts.push(localDraft(name, `第 ${pageNumber} 页`, text, retrievedAt));
    }
    if (drafts.length === 0) throw new Error("PDF 没有提取到文本");
    return drafts;
  } finally {
    await task.destroy();
  }
}

async function xlsxEvidence(buffer: Buffer, name: string, retrievedAt: string): Promise<EvidenceDraft[]> {
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error("XLSX 文件签名不正确");
  const files = await unzipLimited(buffer, MAX_UNZIPPED_BYTES);
  const shared = parseSharedStrings(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "");
  const sheets = [...files.keys()].filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry)).sort().slice(0, 5);
  if (sheets.length === 0) throw new Error("XLSX 没有工作表");
  const drafts: EvidenceDraft[] = [];
  for (const sheetPath of sheets) {
    const rows = parseSheet(files.get(sheetPath)?.toString("utf8") ?? "", shared).slice(0, 200);
    if (rows.length === 0) continue;
    const sheetName = sheetPath.match(/sheet(\d+)/)?.[1] ?? "1";
    drafts.push(localDraft(name, `工作表 ${sheetName}，行 1-${rows.length}`, rows.join("\n"), retrievedAt));
  }
  if (drafts.length === 0) throw new Error("XLSX 没有可读取的单元格");
  return drafts;
}

function textEvidence(value: string, name: string, extension: string, retrievedAt: string): EvidenceDraft[] {
  const text = extension === ".html" || extension === ".htm" ? stripHtml(value) : value.trim();
  if (!text) throw new Error("文件没有可读取的文本");
  const chunks = extension === ".csv" ? chunkLines(text, 40) : chunkLength(text, 1200);
  return chunks.map((chunk, index) => localDraft(name, extension === ".csv" ? `行组 ${index + 1}` : `片段 ${index + 1}`, chunk, retrievedAt));
}

function localDraft(name: string, locator: string, text: string, retrievedAt: string): EvidenceDraft {
  return {
    source: "本地文档",
    sourceGrade: "B",
    title: name,
    url: null,
    publisher: name,
    publishedAt: null,
    retrievedAt,
    reportPeriod: null,
    summary: excerpt(`${locator}：${text}`, 800),
    contentHash: sha256(`${name}|${locator}|${text}`),
    locator,
    category: "本地文档",
    sentiment: null,
  };
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("文本文件不是有效的 UTF-8");
  }
}

function chunkLines(value: string, size: number): string[] {
  const lines = value.split(/\r?\n/).filter((line) => line.trim());
  const chunks: string[] = [];
  for (let index = 0; index < lines.length; index += size) chunks.push(lines.slice(index, index + size).join("\n"));
  return chunks;
}

function chunkLength(value: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) chunks.push(value.slice(index, index + size));
  return chunks;
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map((item) => stripHtml(item[0] ?? ""));
}

function parseSheet(xml: string, shared: string[]): string[] {
  const rows: string[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*r="(\d+)"[\s\S]*?<\/row>/g)) {
    const cells = [...(row[0] ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((cell) => cellText(cell[1] ?? "", cell[2] ?? "", shared));
    if (cells.some(Boolean)) rows.push(`${row[1]}: ${cells.join(" | ")}`);
  }
  return rows;
}

function cellText(attributes: string, inner: string, shared: string[]): string {
  const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
  if (/\bt="s"/.test(attributes)) return shared[Number(value)] ?? "";
  if (/\bt="inlineStr"/.test(attributes)) return stripHtml(inner);
  return stripHtml(value);
}
