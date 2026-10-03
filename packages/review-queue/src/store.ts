import type { Lesson, QueueItem, ReviewDocument, ReviewStatus } from "./types.js";

export interface QueueSummary {
  counts: Record<ReviewStatus, number>;
  lessonsApplied: number;
  oldestPendingAt: string | null;
}

/**
 * Persistence boundary. Every method takes the tenant explicitly: a store
 * never answers a question across tenants, so the service cannot ask one by
 * accident. Two implementations ship: in memory (tests, demo) and Postgres.
 */
export interface QueueStore {
  insertDocument(doc: ReviewDocument): Promise<void>;
  updateDocument(
    tenantId: string,
    id: string,
    patch: Partial<Pick<ReviewDocument, "status" | "processedAt" | "error" | "lineCount">>,
  ): Promise<void>;
  /** Most recent documents first. */
  recentDocuments(tenantId: string, limit: number): Promise<ReviewDocument[]>;

  insertItems(items: QueueItem[]): Promise<void>;
  getItem(tenantId: string, id: string): Promise<QueueItem | null>;
  updateItem(item: QueueItem): Promise<void>;
  /** Oldest first. */
  listItems(tenantId: string, filter?: { status?: ReviewStatus; documentId?: string }): Promise<QueueItem[]>;
  summary(tenantId: string): Promise<QueueSummary>;

  /** Insert or replace by id. */
  saveLesson(lesson: Lesson): Promise<void>;
  listLessons(tenantId: string): Promise<Lesson[]>;
  findLessonByPattern(tenantId: string, pattern: string): Promise<Lesson | null>;
}

export const EMPTY_COUNTS: Record<ReviewStatus, number> = { pending: 0, approved: 0, corrected: 0, rejected: 0 };
