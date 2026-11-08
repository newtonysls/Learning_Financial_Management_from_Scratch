import type { AnalysisResult } from "../shared/types";

export interface JobResponse {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: string[];
  result?: AnalysisResult;
  error?: string;
}

export async function submitAnalysis(form: FormData): Promise<string> {
  const response = await fetch("/api/analysis", { method: "POST", body: form });
  const payload = await response.json() as { id?: string; error?: string };
  if (!response.ok || !payload.id) throw new Error(payload.error ?? "分析请求失败");
  return payload.id;
}

export async function readJob(id: string): Promise<JobResponse> {
  const response = await fetch(`/api/analysis/${id}`);
  const payload = await response.json() as JobResponse & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "无法读取分析任务");
  return payload;
}
