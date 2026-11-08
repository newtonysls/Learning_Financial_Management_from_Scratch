import { DatabaseSync } from "node:sqlite";
import type { EvidenceDraft, EvidenceRecord, SourceGrade } from "../../shared/types";

const RANK: Record<SourceGrade, number> = { A: 4, B: 3, C: 2, D: 1 };

export class EvidenceStore {
  private readonly records: EvidenceRecord[] = [];
  private readonly byHash = new Map<string, number>();

  add(input: EvidenceDraft): EvidenceRecord {
    const index = this.byHash.get(input.contentHash);
    if (index !== undefined) {
      const current = this.records[index];
      if (!current) throw new Error("证据索引损坏");
      if (RANK[input.sourceGrade] > RANK[current.sourceGrade]) {
        const replacement: EvidenceRecord = { ...input, id: `E${index + 1}` };
        this.records[index] = replacement;
        return replacement;
      }
      return current;
    }
    const record: EvidenceRecord = { ...input, id: `E${this.records.length + 1}` };
    this.byHash.set(input.contentHash, this.records.length);
    this.records.push(record);
    return record;
  }

  list(): EvidenceRecord[] {
    return [...this.records];
  }
}

export function searchEvidence(records: EvidenceRecord[], query: string): EvidenceRecord[] {
  const safe = query.replace(/["*:]/g, " ").trim();
  if (!safe) return [];
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE docs USING fts5(id, title, body, tokenize = 'trigram')");
    const insert = db.prepare("INSERT INTO docs(id, title, body) VALUES (?, ?, ?)");
    for (const record of records) insert.run(record.id, record.title, `${record.summary} ${record.publisher ?? ""}`);
    const rows = db.prepare("SELECT id FROM docs WHERE docs MATCH ?").all(safe) as Array<{ id: string }>;
    const ids = new Set(rows.map((row) => row.id));
    return records.filter((record) => ids.has(record.id));
  } catch {
    return records.filter((record) => `${record.title}${record.summary}`.includes(safe));
  } finally {
    db.close();
  }
}
