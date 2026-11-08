import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { createGunzip } from "node:zlib";
import type { IncomingMessage } from "node:http";

export const FINANCIAL_HOSTS = new Set([
  "push2delay.eastmoney.com",
  "push2his.eastmoney.com",
  "push2.eastmoney.com",
  "datacenter-web.eastmoney.com",
  "emweb.securities.eastmoney.com",
  "search-api-web.eastmoney.com",
  "www.cninfo.com.cn",
  "static.cninfo.com.cn",
  "gbapi.eastmoney.com",
  "guba.eastmoney.com",
  "baike.baidu.com",
]);

export interface FetchResult {
  url: string;
  status: number;
  body: Buffer;
  contentType: string;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  mode?: "allowlist" | "public-web";
}

interface PinnedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface PinnedRequestInput {
  url: URL;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  address: string;
  family: number;
  timeoutMs: number;
  maxBytes: number;
}

export type LookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export type PinnedRequestFn = (input: PinnedRequestInput) => Promise<PinnedResponse>;

export interface SafeClient {
  get(url: string, options?: RequestOptions): Promise<FetchResult>;
  post(url: string, body: string, options?: RequestOptions): Promise<FetchResult>;
}

export function assertSafeUrl(raw: string, mode: "allowlist" | "public-web"): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("仅允许访问完整的 HTTPS 地址");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") {
    throw new Error("仅允许访问 443 端口上的 HTTPS 地址");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".localhost")) {
    throw new Error("拒绝访问本地或内部地址");
  }
  if (isIpLiteral(hostname) || (mode === "allowlist" && !FINANCIAL_HOSTS.has(hostname))) {
    throw new Error("目标主机不在允许的公开数据源中");
  }
  if (mode === "public-web" && !hostname.includes(".")) {
    throw new Error("拒绝访问本地或内部地址");
  }
  url.hostname = hostname;
  return url;
}

export function isPrivateIp(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (value.includes(":")) {
    const dotted = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted?.[1]) return isPrivateIp(dotted[1]);
    const mapped = value.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped?.[1] && mapped[2]) {
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      return isPrivateIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd")
      || /^fe[89ab]/.test(value) || value.startsWith("64:ff9b:") || value.startsWith("2002:");
  }
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [first, second] = parts as [number, number, number, number];
  return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127) || (first === 192 && second === 0)
    || (first === 198 && (second === 18 || second === 19)) || first >= 224;
}

export function createHttpClient(deps: { lookup?: LookupFn; request?: PinnedRequestFn } = {}): SafeClient {
  const resolve = deps.lookup ?? defaultLookup;
  const send = deps.request ?? defaultRequest;
  return {
    get: (url, options) => fetchWithRetry("GET", url, undefined, options, resolve, send),
    post: (url, body, options) => fetchWithRetry("POST", url, body, options, resolve, send),
  };
}

export const http = createHttpClient();

async function fetchWithRetry(
  method: "GET" | "POST",
  rawUrl: string,
  body: string | undefined,
  options: RequestOptions | undefined,
  resolve: LookupFn,
  send: PinnedRequestFn,
): Promise<FetchResult> {
  const timeoutMs = options?.timeoutMs ?? 12_000;
  const maxBytes = options?.maxBytes ?? 2_000_000;
  const retries = options?.retries ?? 2;
  const mode = options?.mode ?? "allowlist";
  let url = assertSafeUrl(rawUrl, mode);
  const deadline = Date.now() + timeoutMs * (retries + 1);
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("请求超过总时限");
      const response = await sendOnce(url, method, body, options?.headers ?? {}, Math.min(timeoutMs, remaining), maxBytes, mode, resolve, send);
      if (response.status >= 300 && response.status < 400) {
        const location = headerValue(response.headers, "location");
        if (!location || attempt === retries) throw new Error(`数据源重定向失败：${response.status}`);
        url = assertSafeUrl(new URL(location, url).toString(), mode);
        continue;
      }
      if ([429, 502, 503, 504].includes(response.status) && attempt < retries) {
        await delay(retryDelay(response.headers, attempt));
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        const error = new Error(`数据源返回 HTTP ${response.status}`);
        if (response.status < 500 && response.status !== 429) throw Object.assign(error, { permanent: true });
        throw error;
      }
      return {
        url: url.toString(),
        status: response.status,
        body: response.body,
        contentType: headerValue(response.headers, "content-type") ?? "",
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("数据源请求失败");
      const permanent = typeof error === "object" && error !== null && "permanent" in error;
      if (attempt === retries || permanent || /拒绝|不在允许|仅允许|无效/.test(lastError.message)) break;
      await delay(300 * 3 ** attempt);
    }
  }
  throw lastError ?? new Error("数据源请求失败");
}

async function sendOnce(
  url: URL,
  method: "GET" | "POST",
  body: string | undefined,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
  mode: "allowlist" | "public-web",
  resolve: LookupFn,
  send: PinnedRequestFn,
): Promise<PinnedResponse> {
  const addresses = await resolve(url.hostname);
  const publicAddress = addresses.find((item) => !isPrivateIp(item.address));
  if (!publicAddress || addresses.some((item) => isPrivateIp(item.address))) {
    throw new Error("拒绝访问本地或内部地址");
  }
  if (mode === "allowlist" && !FINANCIAL_HOSTS.has(url.hostname)) {
    throw new Error("目标主机不在允许的公开数据源中");
  }
  const response = await send({
    url,
    method,
    headers: {
      accept: "application/json,text/html,text/plain,*/*",
      "accept-language": "zh-CN,zh;q=0.9",
      "user-agent": "Mozilla/5.0 (compatible; AStockFundamentalResearch/0.1; local research)",
      ...headers,
      ...(body ? { "content-length": Buffer.byteLength(body).toString() } : {}),
    },
    body,
    address: publicAddress.address,
    family: publicAddress.family,
    timeoutMs,
    maxBytes,
  });
  const length = headerValue(response.headers, "content-length");
  if (length && Number(length) > maxBytes) throw new Error("响应超过大小上限");
  return { ...response, body: await decodeLimited(response.body, maxBytes) };
}

async function defaultLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((item) => ({ address: item.address, family: item.family }));
}

function defaultRequest(input: PinnedRequestInput): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(input.url, {
      method: input.method,
      headers: input.headers,
      lookup: (_hostname, options, callback) => {
        const done = typeof options === "function" ? options : callback;
        const all = typeof options === "object" && options !== null && "all" in options && options.all === true;
        if (all) done(null, [{ address: input.address, family: input.family }]);
        else done(null, input.address, input.family);
      },
      timeout: input.timeoutMs,
    }, (response) => {
      readLimited(response, input.maxBytes)
        .then((body) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }))
        .catch(reject);
    });
    request.on("timeout", () => request.destroy(new Error("请求超时")));
    request.on("error", reject);
    if (input.body) request.write(input.body);
    request.end();
  });
}

function readLimited(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    response.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        response.destroy(new Error("响应超过大小上限"));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolve(Buffer.concat(chunks)));
    response.on("error", reject);
  });
}

async function decodeLimited(body: Buffer, maxBytes: number): Promise<Buffer> {
  if (body.length < 2 || body[0] !== 0x1f || body[1] !== 0x8b) return body;
  return await new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let total = 0;
    gunzip.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        gunzip.destroy(new Error("响应超过大小上限"));
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on("end", () => resolve(Buffer.concat(chunks)));
    gunzip.on("error", reject);
    gunzip.end(body);
  });
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function retryDelay(headers: Record<string, string | string[] | undefined>, attempt: number): number {
  const retryAfter = headerValue(headers, "retry-after");
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0), 5) * 1000;
  return 300 * 3 ** attempt;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isIpLiteral(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":");
}
