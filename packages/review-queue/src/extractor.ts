import { ReviewError, type ExtractedLine } from "./types.js";

export interface ExtractionInput {
  /** Document already converted to plain text (OCR, PDF-to-text, CSV export...). */
  text: string;
  hint?: string;
}

/**
 * Anything that turns a document into structured lines. In production this is
 * an LLM call; in tests it is the deterministic mock below. The queue does not
 * care which one it is, and the health check treats a throw from either the
 * same way: the pipeline is broken, not idle.
 */
export interface Extractor {
  readonly name: string;
  extract(input: ExtractionInput): Promise<ExtractedLine[]>;
}

/**
 * Deterministic extractor for tests and demos.
 *
 * Input format, one line per transaction, `|` `;` or tab separated:
 *
 *     2026-09-01 | Rent received - unit 12 | 1500.00
 *
 * Lines that do not parse (headers, blanks, `#` comments) are skipped. A
 * non-empty document with zero parsable lines is treated as a failure, which
 * is what you want surfaced by the health check rather than silently queued
 * as "nothing to review".
 */
export class MockExtractor implements Extractor {
  readonly name = "mock";

  async extract(input: ExtractionInput): Promise<ExtractedLine[]> {
    const rows = input.text.split(/\r?\n/);
    const lines: ExtractedLine[] = [];
    for (const row of rows) {
      const parsed = parseRow(row);
      if (parsed) lines.push(parsed);
    }
    if (lines.length === 0 && input.text.trim().length > 0) {
      throw new ReviewError("extraction_failed", "mock extractor: no parsable lines in document");
    }
    return lines;
  }
}

/**
 * Keyword rules for the mock. Deliberately naive: "project" is mapped to
 * repairs with low confidence, which is the classic mistake a reviewer corrects
 * (an engineering project on a building is a capital improvement, not upkeep).
 * That correction becomes the first lesson in the demo.
 */
const CATEGORY_RULES: ReadonlyArray<{ test: RegExp; category: string; confidence: number }> = [
  { test: /\brent\b/i, category: "rent-income", confidence: 0.92 },
  { test: /\bcondo\b|\bhoa\b|\bcondominium\b/i, category: "condo-fee", confidence: 0.9 },
  { test: /\bproperty tax\b/i, category: "property-tax", confidence: 0.95 },
  { test: /\binsurance\b/i, category: "insurance", confidence: 0.9 },
  { test: /\bmanagement fee\b|\bcommission\b/i, category: "management-fee", confidence: 0.88 },
  { test: /\btransfer\b/i, category: "transfer", confidence: 0.85 },
  { test: /\bproject\b/i, category: "repairs", confidence: 0.55 },
  { test: /\brepair\b|\bplumb|\bpaint|\bfix\b|\bmaintenance\b/i, category: "repairs", confidence: 0.8 },
];

const ENTITY_RULE = /\b(?:unit|apt|suite)\s*#?\s*(\d{1,4})\b/i;

function parseRow(row: string): ExtractedLine | null {
  const trimmed = row.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const parts = trimmed.split(/\s*[|;\t]\s*/);
  if (parts.length < 3) return null;
  const [date, description, amountRaw] = parts as [string, string, string];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const amount = Number(amountRaw.replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;

  const rule = CATEGORY_RULES.find((r) => r.test.test(description));
  const entity = ENTITY_RULE.exec(description);
  return {
    date,
    description,
    amount,
    suggestedCategory: rule?.category ?? null,
    suggestedEntityCode: entity?.[1] ? `UNIT-${entity[1].padStart(3, "0")}` : null,
    confidence: rule?.confidence ?? 0.3,
  };
}
