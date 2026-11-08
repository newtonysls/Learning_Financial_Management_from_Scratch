import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { expect, test, vi } from "vitest";
import { redactSecrets } from "../src/server/analysis/text";
import { parseLocalDocument } from "../src/server/documents/parser";
import { unzipLimited } from "../src/server/documents/zip";
import { assertSafeUrl, createHttpClient, isPrivateIp } from "../src/server/sources/http";

test("blocks private hosts before making a request", async () => {
  expect(() => assertSafeUrl("http://127.0.0.1/latest", "allowlist")).toThrow(/HTTPS/);
  expect(() => assertSafeUrl("https://evil.example/data", "allowlist")).toThrow(/允许/);
  expect(isPrivateIp("10.1.1.1")).toBe(true);
  expect(isPrivateIp("169.254.169.254")).toBe(true);
  expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
  const request = vi.fn();
  const client = createHttpClient({ lookup: async () => [{ address: "127.0.0.1", family: 4 }], request });
  await expect(client.get("https://push2delay.eastmoney.com/api")).rejects.toThrow(/内部/);
  expect(request).not.toHaveBeenCalled();
});

test("rejects escaped upload paths and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-"));
  const outside = await mkdtemp(join(tmpdir(), "secret-"));
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "密钥");
  const link = join(root, "link.txt");
  await symlink(secret, link);
  await expect(parseLocalDocument(link, root, "2026-11-08T00:00:00.000Z")).rejects.toThrow(/符号链接/);
  await expect(parseLocalDocument(secret, root, "2026-11-08T00:00:00.000Z")).rejects.toThrow(/知识库/);
});

test("stops a zip entry before accepting oversized output", async () => {
  const payload = Buffer.alloc(100, 1);
  const compressed = deflateRawSync(payload);
  const name = Buffer.from("xl/sharedStrings.xml");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt16LE(name.length, 26);
  await expect(unzipLimited(Buffer.concat([header, name, compressed]), 50)).rejects.toThrow(/安全上限/);
});

test("redacts configured API keys", () => {
  process.env.OPENAI_COMPAT_API_KEY = "sk-test-secret";
  expect(redactSecrets("failed sk-test-secret")).toBe("failed [REDACTED]");
  delete process.env.OPENAI_COMPAT_API_KEY;
});
