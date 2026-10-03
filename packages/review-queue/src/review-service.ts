import { randomUUID } from "node:crypto";
import type { Extractor } from "./extractor.js";
import { LessonEngine, patternOf } from "./lesson-engine.js";
import type { QueueStore } from "./store.js";
import {
  ReviewError,
  type Correction,
  type HealthOptions,
  type HealthReport,
  type IngestInput,
  type IngestResult,
  type Lesson,
  type Metrics,
  type QueueItem,
  type ReviewDocument,
  type ReviewStatus,
} from "./types.js";

export interface ReviewServiceDeps {
  store: QueueStore;
  extractor: Extractor;
  lessons?: LessonEngine;
  /** Injectable for deterministic tests. */
  now?: () => Date;
  newId?: () => string;
}

/**
 * The use cases, with no HTTP in sight. Every public method takes the tenant
 * first and refuses to see data from any other tenant: an item id from company
 * A is simply "not found" when asked for under company B.
 */
export class ReviewService {
  private readonly store: QueueStore;
  private readonly extractor: Extractor;
  private readonly lessons: LessonEngine;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: ReviewServiceDeps) {
    this.store = deps.store;
    this.extractor = deps.extractor;
    this.lessons = deps.lessons ?? new LessonEngine();
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  /**
   * Record the document, extract, apply known lessons, enqueue as pending.
   * The document row is written *before* extraction so a crash or a model
   * error leaves a visible `failed` document behind instead of silence.
   */
  async ingest(input: IngestInput): Promise<IngestResult> {
    requireText(input.tenantId, "tenantId");
    requireText(input.source, "source");
    if (typeof input.text !== "string") throw new ReviewError("bad_request", "text is required");

    const doc: ReviewDocument = {
      id: this.newId(),
      tenantId: input.tenantId,
      source: input.source,
      receivedAt: this.iso(),
      processedAt: null,
      status: "received",
      error: null,
      lineCount: 0,
    };
    await this.store.insertDocument(doc);

    let lines;
    try {
      lines = await this.extractor.extract({ text: input.text, ...(input.hint !== undefined && { hint: input.hint }) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.updateDocument(doc.tenantId, doc.id, { status: "failed", error: message, processedAt: this.iso() });
      throw new ReviewError("extraction_failed", `${this.extractor.name} extractor failed: ${message}`, { cause: error });
    }

    const known = await this.store.listLessons(input.tenantId);
    const touched = new Map<string, Lesson>();
    const items: QueueItem[] = [];
    for (const line of lines) {
      const match = this.lessons.match(line.description, known);
      if (match) {
        match.lesson.timesApplied += 1;
        touched.set(match.lesson.id, match.lesson);
      }
      items.push({
        id: this.newId(),
        tenantId: input.tenantId,
        documentId: doc.id,
        line,
        status: "pending",
        category: match?.lesson.category ?? line.suggestedCategory,
        entityCode: match?.lesson.entityCode ?? line.suggestedEntityCode,
        appliedLessonId: match?.lesson.id ?? null,
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
        createdAt: this.iso(),
      });
    }

    await this.store.insertItems(items);
    for (const lesson of touched.values()) await this.store.saveLesson(lesson);
    await this.store.updateDocument(doc.tenantId, doc.id, { status: "processed", processedAt: this.iso(), lineCount: items.length });

    return { documentId: doc.id, items, lessonsApplied: items.filter((i) => i.appliedLessonId).length };
  }

  async listQueue(tenantId: string, filter: { status?: ReviewStatus } = {}): Promise<QueueItem[]> {
    requireText(tenantId, "tenantId");
    return this.store.listItems(tenantId, filter);
  }

  /** The suggestion was right. Nothing to learn, but the approval counts toward first-pass accuracy. */
  async approve(tenantId: string, itemId: string, reviewer: string): Promise<QueueItem> {
    const item = await this.pendingItem(tenantId, itemId);
    return this.finish(item, "approved", reviewer, null);
  }

  /**
   * The suggestion was wrong. Fix the item and turn the fix into a lesson keyed
   * by the description pattern, so the next similar line arrives pre-corrected.
   * If a lesson already exists for the pattern, the newest human decision wins.
   */
  async correct(tenantId: string, itemId: string, reviewer: string, correction: Correction): Promise<QueueItem> {
    const item = await this.pendingItem(tenantId, itemId);
    if (correction.category === undefined && correction.entityCode === undefined) {
      throw new ReviewError("bad_request", "a correction must change category or entityCode");
    }
    const category = correction.category ?? item.category;
    const entityCode = correction.entityCode ?? item.entityCode;
    if (category === item.category && entityCode === item.entityCode) {
      throw new ReviewError("bad_request", "correction changes nothing; approve the item instead");
    }

    item.category = category;
    item.entityCode = entityCode;
    const saved = await this.finish(item, "corrected", reviewer, correction.note ?? null);

    const pattern = patternOf(item.line.description);
    if (pattern) {
      const existing = await this.store.findLessonByPattern(tenantId, pattern);
      const lesson: Lesson = existing
        ? { ...existing, sourceItemId: item.id, updatedAt: this.iso() }
        : {
            id: this.newId(),
            tenantId,
            pattern,
            category: null,
            entityCode: null,
            sourceItemId: item.id,
            createdAt: this.iso(),
            updatedAt: this.iso(),
            timesApplied: 0,
          };
      if (correction.category !== undefined) lesson.category = correction.category;
      if (correction.entityCode !== undefined) lesson.entityCode = correction.entityCode;
      await this.store.saveLesson(lesson);
    }
    return saved;
  }

  /**
   * The line should not exist (a memo line, a duplicate, not this company's
   * money). Rejections are kept as feedback but do not create lessons: in
   * practice they are contextual judgement calls, and an automatic drop rule
   * built from them is how real lines go missing.
   */
  async reject(tenantId: string, itemId: string, reviewer: string, reason: string): Promise<QueueItem> {
    requireText(reason, "reason");
    const item = await this.pendingItem(tenantId, itemId);
    return this.finish(item, "rejected", reviewer, reason);
  }

  async metrics(tenantId: string): Promise<Metrics> {
    requireText(tenantId, "tenantId");
    const [summary, lessons] = await Promise.all([this.store.summary(tenantId), this.store.listLessons(tenantId)]);
    const { pending, approved, corrected, rejected } = summary.counts;
    const reviewed = approved + corrected + rejected;
    return {
      tenantId,
      pending,
      approved,
      corrected,
      rejected,
      reviewed,
      firstPassAccuracy: reviewed === 0 ? null : approved / reviewed,
      lessons: lessons.length,
      lessonsApplied: summary.lessonsApplied,
      oldestPendingAt: summary.oldestPendingAt,
    };
  }

  /**
   * Answers the question an empty review screen raises: did nothing arrive, or
   * did something arrive and break? Three states, each with a different person
   * to call: `idle` means the sender, `broken` means the engineer.
   */
  async health(tenantId: string, options: HealthOptions = {}): Promise<HealthReport> {
    requireText(tenantId, "tenantId");
    const idleAfterDays = options.idleAfterDays ?? 10;
    const stuckAfterMinutes = options.stuckAfterMinutes ?? 60;
    const recentWindow = options.recentWindow ?? 10;

    const [recent, summary] = await Promise.all([this.store.recentDocuments(tenantId, recentWindow), this.store.summary(tenantId)]);
    const now = this.now();
    const last = recent[0] ?? null;
    const recentFailures = recent.filter((d) => d.status === "failed").length;
    const base = {
      tenantId,
      checkedAt: now.toISOString(),
      lastDocument: last
        ? { id: last.id, source: last.source, status: last.status, receivedAt: last.receivedAt, processedAt: last.processedAt, error: last.error }
        : null,
      daysSinceLastDocument: last ? daysBetween(new Date(last.receivedAt), now) : null,
      recentFailures,
      pending: summary.counts.pending,
    };

    if (!last) {
      return { ...base, status: "idle", reason: "no documents received yet for this tenant" };
    }
    if (last.status === "failed") {
      return { ...base, status: "broken", reason: `last document (${last.source}) failed: ${last.error ?? "unknown error"}` };
    }
    if (last.status === "received") {
      const minutes = (now.getTime() - new Date(last.receivedAt).getTime()) / 60_000;
      if (minutes > stuckAfterMinutes) {
        return { ...base, status: "broken", reason: `document ${last.id} received ${Math.round(minutes)} min ago and still not processed` };
      }
      return { ...base, status: "ok", reason: "a document is being processed" };
    }
    const days = base.daysSinceLastDocument ?? 0;
    if (days > idleAfterDays) {
      return {
        ...base,
        status: "idle",
        reason: `no document in ${days} days (threshold ${idleAfterDays}); the pipeline is fine, check the sender`,
      };
    }
    const failureNote = recentFailures > 0 ? `; ${recentFailures} of the last ${recent.length} documents failed` : "";
    return { ...base, status: "ok", reason: `last document processed ${days} day(s) ago${failureNote}` };
  }

  private async pendingItem(tenantId: string, itemId: string): Promise<QueueItem> {
    requireText(tenantId, "tenantId");
    requireText(itemId, "itemId");
    const item = await this.store.getItem(tenantId, itemId);
    if (!item) throw new ReviewError("not_found", `item ${itemId} not found`);
    if (item.status !== "pending") {
      throw new ReviewError("invalid_transition", `item ${itemId} is already ${item.status}; reviewed items are immutable`);
    }
    return item;
  }

  private async finish(item: QueueItem, status: ReviewStatus, reviewer: string, note: string | null): Promise<QueueItem> {
    requireText(reviewer, "reviewer");
    item.status = status;
    item.reviewedBy = reviewer;
    item.reviewedAt = this.iso();
    item.reviewNote = note;
    await this.store.updateItem(item);
    return item;
  }

  private iso(): string {
    return this.now().toISOString();
  }
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new ReviewError("bad_request", `${field} is required`);
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}
