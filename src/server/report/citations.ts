import type { EvidenceRecord } from "../../shared/types";

export interface CitationValidation {
  valid: boolean;
  unknown: string[];
  cited: string[];
}

export function validateCitations(markdown: string, evidence: EvidenceRecord[]): CitationValidation {
  const known = new Set(evidence.map((item) => item.id));
  const cited = new Set<string>();
  const unknown: string[] = [];
  for (const match of markdown.matchAll(/\[(E\d+)\]/g)) {
    const id = match[1];
    if (!id) continue;
    cited.add(id);
    if (!known.has(id)) unknown.push(id);
  }
  const valid = unknown.length === 0 && (evidence.length === 0 || cited.size > 0);
  return { valid, unknown, cited: [...cited] };
}

export function cite(ids: string[]): string {
  return [...new Set(ids)].map((id) => `[${id}]`).join("");
}
