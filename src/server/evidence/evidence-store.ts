import { createHash } from "node:crypto";
import type {
  EvidenceRecord,
  SourceGrade,
} from "../../shared/types";

export type EvidenceInput = Omit<EvidenceRecord, "retrievedAt"> & {
  retrievedAt?: string;
};

const SOURCE_STRENGTH: Record<SourceGrade, number> = {
  A: 4,
  B: 3,
  C: 2,
  D: 1,
};

export class EvidenceStore {
  readonly #recordsByHash = new Map<string, EvidenceRecord>();
  readonly #now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.#now = now;
  }

  add(input: EvidenceInput): EvidenceRecord {
    assertSourceGrade(input.sourceGrade);
    if (!input.contentHash.trim()) {
      throw new Error("evidence content hash is required");
    }

    const record: EvidenceRecord = {
      ...input,
      retrievedAt: input.retrievedAt ?? this.#now(),
    };
    const existing = this.#recordsByHash.get(record.contentHash);
    if (
      !existing ||
      SOURCE_STRENGTH[record.sourceGrade] >
        SOURCE_STRENGTH[existing.sourceGrade]
    ) {
      this.#recordsByHash.set(record.contentHash, cloneRecord(record));
    }

    return cloneRecord(
      this.#recordsByHash.get(record.contentHash) as EvidenceRecord,
    );
  }

  addMany(records: EvidenceInput[]): void {
    records.forEach((record) => this.add(record));
  }

  list(): EvidenceRecord[] {
    return [...this.#recordsByHash.values()].map(cloneRecord);
  }
}

export function hashContent(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertSourceGrade(value: unknown): asserts value is SourceGrade {
  if (
    typeof value !== "string" ||
    !Object.hasOwn(SOURCE_STRENGTH, value)
  ) {
    throw new Error("invalid evidence source grade");
  }
}

function cloneRecord(record: EvidenceRecord): EvidenceRecord {
  return {
    ...record,
    sourceUrls: record.sourceUrls
      ? [...record.sourceUrls]
      : undefined,
    locator: record.locator ? { ...record.locator } : undefined,
  };
}
