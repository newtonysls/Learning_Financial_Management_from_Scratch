import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import express, { type Express, type Request, type Response } from "express";
import Busboy from "busboy";
import { z } from "zod";
import { normalizeStockId } from "./domain/stock-id";
import { buildResearchPackage, type ResearchInput } from "./research/build-research";
import { generateDeterministicReport } from "./report/report";
import { enhanceReport } from "./model/enhance";
import { JobStore } from "./jobs/job-store";
import { dataRoot, latestResearchPath, projectRoot } from "./paths";
import { redactSecrets } from "./analysis/text";
import type { AnalysisResult } from "../shared/types";

const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".txt", ".md", ".csv", ".html", ".htm", ".xlsx"]);
const ALLOWED_MIME = new Set([
  "",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
]);

export interface AppOptions {
  research?: typeof buildResearchPackage;
  jobs?: JobStore;
  maxConcurrent?: number;
  uploadRoot?: string;
  enableVite?: boolean;
  enhance?: boolean;
}

export async function createApp(options: AppOptions = {}): Promise<Express> {
  const app = express();
  const jobs = options.jobs ?? new JobStore();
  const research = options.research ?? buildResearchPackage;
  const maxConcurrent = options.maxConcurrent ?? 2;
  const uploadRoot = options.uploadRoot ?? join(dataRoot, "uploads");
  let running = 0;
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.post("/api/analysis", async (request, response, next) => {
    try {
      if (running >= maxConcurrent) {
        response.status(429).json({ error: "已有两个分析任务在运行，请稍后再试" });
        return;
      }
      running += 1;
      let handedOff = false;
      try {
        const submitted = await readSubmission(request, uploadRoot);
        const stock = z.object({ stockCode: z.string().trim().min(1).max(20) }).parse({ stockCode: submitted.stockCode });
        normalizeStockId(stock.stockCode);
        const job = jobs.create();
        jobs.update(job.id, { status: "running", progress: ["已接收分析请求"] });
        response.status(202).json({ id: job.id });
        handedOff = true;
        void runJob(job.id, { stockCode: stock.stockCode, documentPaths: submitted.files, knowledgeRoot: submitted.files.length > 0 ? submitted.root : undefined }, jobs, research, options.enhance !== false)
          .finally(() => {
            running -= 1;
          });
      } catch (error) {
        if (!handedOff) running -= 1;
        throw error;
      }
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/analysis/:id", (request, response) => {
    const job = jobs.get(param(request.params.id));
    if (!job) {
      response.status(404).json({ error: "分析任务不存在" });
      return;
    }
    response.json(job);
  });

  app.get("/api/analysis/:id/report.md", (request, response) => {
    const job = jobs.get(param(request.params.id));
    if (!job?.result) {
      response.status(404).json({ error: "报告尚未生成" });
      return;
    }
    const filename = `${job.result.stock.canonical}-基本面报告.md`;
    response.setHeader("content-type", "text/markdown; charset=utf-8");
    response.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    response.send(job.result.reportMarkdown);
  });

  if (options.enableVite) await attachVite(app);
  else attachProduction(app);

  app.use((error: unknown, _request: Request, response: Response, next: (error?: unknown) => void) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const message = error instanceof Error ? error.message : "请求失败";
    const status = error instanceof z.ZodError || /股票代码|文件|知识库|符号链接|10MB|UTF-8|有效的 6 位/.test(message) ? 400 : 500;
    response.status(status).json({ error: redactSecrets(message) });
  });
  return app;
}

async function runJob(
  id: string,
  input: ResearchInput,
  jobs: JobStore,
  research: typeof buildResearchPackage,
  enhance: boolean,
): Promise<void> {
  try {
    const researchPackage = await research(input, (message) => {
      const current = jobs.get(id);
      if (!current) return;
      jobs.update(id, { progress: [...current.progress, message] });
    });
    const report = generateDeterministicReport(researchPackage);
    const narrative = enhance ? await enhanceReport(report.markdown, researchPackage) : { markdown: report.markdown, mode: "deterministic" as const };
    const result: AnalysisResult = { ...researchPackage, reportMarkdown: narrative.markdown, narrativeMode: narrative.mode };
    await mkdir(dataRoot, { recursive: true });
    await writeFile(latestResearchPath, JSON.stringify(result));
    jobs.update(id, { status: "succeeded", result });
  } catch (error) {
    jobs.update(id, { status: "failed", error: redactSecrets(error instanceof Error ? error.message : "分析失败") });
  }
}

async function readSubmission(request: Request, uploadRoot: string): Promise<{ stockCode: string; files: string[]; root: string }> {
  const type = request.header("content-type") ?? "";
  if (!type.includes("multipart/form-data")) {
    const body = z.object({ stockCode: z.string() }).parse(request.body);
    return { stockCode: body.stockCode, files: [], root: uploadRoot };
  }
  const root = join(uploadRoot, randomBytes(8).toString("hex"));
  await mkdir(root, { recursive: true });
  return await new Promise((resolveSubmission, reject) => {
    const busboy = Busboy({ headers: request.headers, limits: { files: 8, fileSize: MAX_FILE_BYTES, fields: 4, fieldSize: 100 } });
    let stockCode = "";
    let total = 0;
    const files: string[] = [];
    const writes: Array<Promise<void>> = [];
    busboy.on("field", (name, value) => {
      if (name === "stockCode") stockCode = value;
    });
    busboy.on("file", (name, file, info) => {
      const extension = extname(info.filename ?? "").toLowerCase();
      const mime = info.mimeType ?? "";
      if (name !== "documents" || !ALLOWED_EXTENSIONS.has(extension) || !ALLOWED_MIME.has(mime)) {
        file.resume();
        reject(new Error("文件类型不受支持"));
        return;
      }
      const filename = `${randomBytes(8).toString("hex")}${extension}`;
      const target = join(root, filename);
      if (relative(root, target).startsWith("..")) {
        file.resume();
        reject(new Error("文件不在知识库目录内"));
        return;
      }
      const chunks: Buffer[] = [];
      file.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_TOTAL_BYTES) {
          reject(new Error("上传文件合计超过 20MB"));
          file.resume();
          return;
        }
        chunks.push(chunk);
      });
      file.on("limit", () => reject(new Error("文件超过 10MB 上限")));
      writes.push(new Promise((resolveWrite) => {
        file.on("end", () => {
          void writeFile(target, Buffer.concat(chunks)).then(() => {
            files.push(target);
            resolveWrite();
          });
        });
      }));
    });
    busboy.on("error", reject);
    busboy.on("finish", () => {
      void Promise.all(writes).then(() => resolveSubmission({ stockCode, files, root })).catch(reject);
    });
    request.pipe(busboy);
  });
}

function attachProduction(app: Express): void {
  const dist = join(projectRoot, "dist");
  app.use(express.static(dist));
  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path.startsWith("/api")) {
      next();
      return;
    }
    response.sendFile(join(dist, "index.html"));
  });
}

async function attachVite(app: Express): Promise<void> {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "custom" });
  app.use(vite.middlewares);
  app.use(async (request, response, next) => {
    if (request.method !== "GET" || request.path.startsWith("/api")) {
      next();
      return;
    }
    try {
      const template = readFileSync(join(projectRoot, "index.html"), "utf8");
      response.status(200).type("html").end(await vite.transformIndexHtml(request.originalUrl, template));
    } catch (error) {
      next(error);
    }
  });
}

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
