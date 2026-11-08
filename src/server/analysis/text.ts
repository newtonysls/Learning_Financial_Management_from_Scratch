import { createHash } from "node:crypto";
import type { Sentiment } from "../../shared/types";

const POSITIVE = ["增长", "创新高", "盈利", "预增", "回购", "增持", "中标", "超预期", "分红", "扭亏", "看好", "上涨"];
const NEGATIVE = ["下滑", "下降", "亏损", "预减", "违规", "处罚", "诉讼", "减持", "暴跌", "质押", "退市", "造假", "立案", "下跌", "暴雷", "问询"];

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function classifySentiment(text: string): Sentiment {
  const negative = NEGATIVE.some((word) => text.includes(word));
  const positive = POSITIVE.some((word) => text.includes(word));
  if (negative) return "negative";
  if (positive) return "positive";
  return "neutral";
}

export function excerpt(value: string, limit = 500): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}…`;
}

export function decodeEntitiesOnce(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
  };
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    return named[body] ?? entity;
  });
}

export function stripHtml(value: string): string {
  const withoutDanger = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  return decodeEntitiesOnce(withoutDanger.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function formatYi(value: number): string {
  if (!Number.isFinite(value)) return "数据不足";
  const absolute = Math.abs(value);
  if (absolute >= 100_000_000) {
    return `${(value / 100_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} 亿元`;
  }
  if (absolute >= 10_000) {
    return `${(value / 10_000).toLocaleString("zh-CN", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} 万元`;
  }
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} 元`;
}

export function formatNumber(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "数据不足";
  return value.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "数据不足";
  return `${(value * 100).toFixed(2)}%`;
}

export function formatShanghai(iso: string): string {
  const formatted = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
  return `${formatted}（北京时间）`;
}

export function shanghaiDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function redactSecrets(text: string): string {
  const secrets = [process.env.OPENAI_COMPAT_API_KEY, process.env.CURSOR_API_KEY]
    .filter((value): value is string => Boolean(value && value.length > 3));
  return secrets.reduce((output, secret) => output.split(secret).join("[REDACTED]"), text);
}
