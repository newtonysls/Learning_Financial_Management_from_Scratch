import { isIP } from "node:net";

const MAX_TIMEOUT_MS = 12_000;
const MAX_RETRIES = 2;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ABSOLUTE_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

export interface SafeFetchOptions {
  allowedHosts?: string[];
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  maxRetries?: number;
  request?: RequestInit;
  timeoutMs?: number;
}

export async function safeFetchJson<T = unknown>(
  input: string | URL,
  options: SafeFetchOptions = {},
): Promise<T> {
  const url = validateUrl(input, options.allowedHosts ?? []);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is unavailable");
  }

  const timeoutMs = boundedPositiveInteger(
    options.timeoutMs,
    MAX_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const maxResponseBytes = boundedPositiveInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    ABSOLUTE_MAX_RESPONSE_BYTES,
  );
  const maxRetries = Math.min(
    MAX_RETRIES,
    Math.max(0, Math.trunc(options.maxRetries ?? MAX_RETRIES)),
  );
  const request = validateRequest(options.request);

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      timeoutController.abort(
        new Error(`request timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const response = await fetchImpl(url, {
        ...request,
        redirect: "manual",
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error("redirect responses are not allowed");
      }
      if (!response.ok) {
        await response.body?.cancel();
        const error = new HttpStatusError(response.status);
        if (attempt < maxRetries && isRetryableStatus(response.status)) {
          lastError = error;
          continue;
        }
        throw error;
      }

      return await parseBoundedJson<T>(response, maxResponseBytes);
    } catch (error) {
      const normalizedError = timeoutController.signal.aborted
        ? timeoutController.signal.reason
        : error;
      lastError = normalizedError;
      if (
        attempt >= maxRetries ||
        normalizedError instanceof HttpStatusError ||
        request.signal?.aborted
      ) {
        throw normalizedError;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("request failed");
}

function validateUrl(
  input: string | URL,
  allowedHosts: string[],
): URL {
  const url = new URL(input);
  if (url.protocol !== "https:") {
    throw new Error("only HTTPS source URLs are allowed");
  }
  if (url.username || url.password) {
    throw new Error("source URL credentials are not allowed");
  }
  if (url.port && url.port !== "443") {
    throw new Error("only the standard HTTPS port is allowed");
  }

  const hostname = stripIpv6Brackets(url.hostname.toLowerCase());
  if (isPrivateDestination(hostname)) {
    throw new Error("private or loopback destinations are not allowed");
  }

  const normalizedAllowedHosts = new Set(
    allowedHosts.map((host) =>
      stripIpv6Brackets(host.trim().toLowerCase()),
    ),
  );
  if (
    normalizedAllowedHosts.size === 0 ||
    !normalizedAllowedHosts.has(hostname)
  ) {
    throw new Error(`source host is not allowlisted: ${hostname}`);
  }
  return url;
}

function validateRequest(request: RequestInit = {}): RequestInit {
  const method = (request.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new Error("only GET and POST source requests are allowed");
  }
  if (
    request.body !== undefined &&
    request.body !== null &&
    requestBodySize(request.body) > MAX_REQUEST_BODY_BYTES
  ) {
    throw new Error("request body exceeds the allowed size");
  }
  return { ...request, method };
}

function requestBodySize(body: BodyInit): number {
  if (typeof body === "string") {
    return Buffer.byteLength(body);
  }
  if (body instanceof URLSearchParams) {
    return Buffer.byteLength(body.toString());
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }
  throw new Error("unsupported request body type");
}

async function parseBoundedJson<T>(
  response: Response,
  maxBytes: number,
): Promise<T> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) ||
      Number(contentLength) > maxBytes)
  ) {
    await response.body?.cancel();
    throw new Error("response body exceeds the allowed size");
  }

  if (!response.body) {
    throw new Error("response body is empty");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("response body exceeds the allowed size");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("response body is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("response body is not valid JSON");
  }
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("fetch limit must be a positive finite number");
  }
  return Math.min(Math.trunc(value), maximum);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isPrivateDestination(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return true;
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    return isPrivateIpv4(hostname);
  }
  if (ipVersion === 6) {
    return isPrivateIpv6(hostname);
  }
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  const first = octets[0] as number;
  const second = octets[1] as number;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized)
  ) {
    return true;
  }
  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mappedIpv4 ? isPrivateIpv4(mappedIpv4[1] as string) : false;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`source request failed with HTTP ${status}`);
  }
}
