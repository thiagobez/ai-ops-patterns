/**
 * Core types for the review queue.
 *
 * The one rule that shapes everything here: a line produced by a model never
 * becomes a booked transaction on its own. It enters the queue as `pending`
 * and leaves only through a human decision. The queue row is also the audit
 * record, so it keeps the original model output untouched next to whatever
 * the reviewer decided.
 */

export type ReviewStatus = "pending" | "approved" | "corrected" | "rejected";

/** One structured line as produced by an Extractor. Stored verbatim, never mutated. */
export interface ExtractedLine {
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  description: string;
  /** Signed amount in currency units: positive is money in, negative is money out. */
  amount: number;
  suggestedCategory: string | null;
  /** Code of the entity the line belongs to (a unit, a cost centre, a contract...). */
  suggestedEntityCode: string | null;
  /** Extractor's own confidence, 0..1. Informational: it never gates a decision. */
  confidence: number;
}

export type DocumentStatus = "received" | "processed" | "failed";

/** A document that arrived for extraction (a statement, a report, a PDF already turned into text). */
export interface ReviewDocument {
  id: string;
  tenantId: string;
  /** Where it came from, e.g. `email:monthly-statement`. Free text, for humans. */
  source: string;
  receivedAt: string;
  processedAt: string | null;
  status: DocumentStatus;
  error: string | null;
  lineCount: number;
}

export interface QueueItem {
  id: string;
  tenantId: string;
  documentId: string;
  /** Original extractor output. Kept as-is so the model can be evaluated later. */
  line: ExtractedLine;
  status: ReviewStatus;
  /** Effective values: the suggestion, possibly improved by a lesson, possibly corrected by a human. */
  category: string | null;
  entityCode: string | null;
  /** Set when a lesson changed the suggestion before a human saw it. */
  appliedLessonId: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** Free text from the reviewer: the reason for a rejection, a note on a correction. */
  reviewNote: string | null;
  createdAt: string;
}

/**
 * What a human correction teaches the system: "descriptions that look like
 * this pattern belong to this category / entity". `null` means the lesson has
 * nothing to say about that field, not "clear it".
 */
export interface Lesson {
  id: string;
  tenantId: string;
  /** Canonical token pattern, see `patternOf()` in the lesson engine. */
  pattern: string;
  category: string | null;
  entityCode: string | null;
  /** The queue item whose correction created (or last updated) the lesson. */
  sourceItemId: string;
  createdAt: string;
  updatedAt: string;
  timesApplied: number;
}

/** Fields a reviewer can change. Omitted fields are left as they were. */
export interface Correction {
  category?: string;
  entityCode?: string;
  note?: string;
}

export interface IngestInput {
  tenantId: string;
  source: string;
  text: string;
  /** Optional hint for the extractor, e.g. the bank or the statement type. */
  hint?: string;
}

export interface IngestResult {
  documentId: string;
  items: QueueItem[];
  lessonsApplied: number;
}

export interface Metrics {
  tenantId: string;
  pending: number;
  approved: number;
  corrected: number;
  rejected: number;
  /** approved + corrected + rejected */
  reviewed: number;
  /**
   * Share of reviewed lines the human approved without touching anything.
   * `null` until the first review: no data is not the same as zero accuracy.
   */
  firstPassAccuracy: number | null;
  lessons: number;
  /** Queue items (any status) whose suggestion was changed by a lesson. */
  lessonsApplied: number;
  oldestPendingAt: string | null;
}

export type HealthStatus = "ok" | "idle" | "broken";

export interface HealthReport {
  tenantId: string;
  status: HealthStatus;
  /** One sentence a person on call can act on. */
  reason: string;
  checkedAt: string;
  lastDocument: Pick<ReviewDocument, "id" | "source" | "status" | "receivedAt" | "processedAt" | "error"> | null;
  daysSinceLastDocument: number | null;
  /** Failures among the most recent documents, even if the latest one succeeded. */
  recentFailures: number;
  pending: number;
}

export interface HealthOptions {
  /** After this many days without a document the source is considered silent. Default 10. */
  idleAfterDays?: number;
  /** A document still `received` after this long is considered stuck. Default 60. */
  stuckAfterMinutes?: number;
  /** How many recent documents to inspect for failures. Default 10. */
  recentWindow?: number;
}

export type ReviewErrorCode = "bad_request" | "not_found" | "invalid_transition" | "extraction_failed";

export class ReviewError extends Error {
  constructor(
    readonly code: ReviewErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ReviewError";
  }
}
