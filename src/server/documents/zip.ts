import { createInflateRaw } from "node:zlib";

export async function unzipLimited(buffer: Buffer, maxBytes: number): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  let total = 0;
  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) throw new Error("压缩包结构损坏");
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    if (flags & 0x1) throw new Error("拒绝解析加密文件");
    if (dataStart > buffer.length) throw new Error("压缩包结构损坏");
    const dataEnd = compressedSize > 0 ? dataStart + compressedSize : findNextHeader(buffer, dataStart);
    if (dataEnd > buffer.length) throw new Error("压缩包结构损坏");
    const name = buffer.toString("utf8", nameStart, nameStart + nameLength);
    const compressed = buffer.subarray(dataStart, dataEnd);
    const output = method === 0 ? Buffer.from(compressed) : method === 8 ? await inflateLimited(compressed, maxBytes - total) : null;
    if (!output) throw new Error("不支持的压缩方法");
    total += output.length;
    if (total > maxBytes) throw new Error("解压后的文件超过安全上限");
    files.set(name, output);
    offset = dataEnd;
  }
  return files;
}

function findNextHeader(buffer: Buffer, start: number): number {
  for (let index = start; index <= buffer.length - 4; index += 1) {
    const signature = buffer.readUInt32LE(index);
    if (signature === 0x04034b50 || signature === 0x02014b50) return index;
  }
  throw new Error("压缩包结构损坏");
}

function inflateLimited(buffer: Buffer, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const inflater = createInflateRaw();
    const chunks: Buffer[] = [];
    let total = 0;
    inflater.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        inflater.destroy(new Error("解压后的文件超过安全上限"));
        return;
      }
      chunks.push(chunk);
    });
    inflater.on("error", reject);
    inflater.on("end", () => resolve(Buffer.concat(chunks)));
    inflater.end(buffer);
  });
}
