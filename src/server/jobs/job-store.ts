import { randomUUID } from "node:crypto";
import type { AnalysisResult } from "../../shared/types";

export interface AnalysisJob {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: string[];
  result?: AnalysisResult;
  error?: string;
}

export class JobStore {
  private readonly jobs = new Map<string, AnalysisJob>();

  create(): AnalysisJob {
    const job: AnalysisJob = { id: randomUUID(), status: "queued", progress: [] };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): AnalysisJob | undefined {
    return this.jobs.get(id);
  }

  update(id: string, patch: Partial<AnalysisJob>): AnalysisJob {
    const current = this.jobs.get(id);
    if (!current) throw new Error("分析任务不存在");
    const next = { ...current, ...patch, progress: patch.progress ?? current.progress };
    this.jobs.set(id, next);
    return next;
  }
}
