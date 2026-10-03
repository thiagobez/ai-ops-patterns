import { EMPTY_COUNTS, type QueueStore, type QueueSummary } from "./store.js";
import type { Lesson, QueueItem, ReviewDocument, ReviewStatus } from "./types.js";

/** Reference implementation. Copies on the way in and out so callers cannot mutate stored state by accident. */
export class InMemoryStore implements QueueStore {
  private readonly documents = new Map<string, ReviewDocument>();
  private readonly items = new Map<string, QueueItem>();
  private readonly lessons = new Map<string, Lesson>();

  async insertDocument(doc: ReviewDocument): Promise<void> {
    this.documents.set(doc.id, structuredClone(doc));
  }

  async updateDocument(
    tenantId: string,
    id: string,
    patch: Partial<Pick<ReviewDocument, "status" | "processedAt" | "error" | "lineCount">>,
  ): Promise<void> {
    const doc = this.documents.get(id);
    if (!doc || doc.tenantId !== tenantId) return;
    this.documents.set(id, { ...doc, ...patch });
  }

  async recentDocuments(tenantId: string, limit: number): Promise<ReviewDocument[]> {
    return [...this.documents.values()]
      .filter((d) => d.tenantId === tenantId)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, limit)
      .map((d) => structuredClone(d));
  }

  async insertItems(items: QueueItem[]): Promise<void> {
    for (const item of items) this.items.set(item.id, structuredClone(item));
  }

  async getItem(tenantId: string, id: string): Promise<QueueItem | null> {
    const item = this.items.get(id);
    return item && item.tenantId === tenantId ? structuredClone(item) : null;
  }

  async updateItem(item: QueueItem): Promise<void> {
    this.items.set(item.id, structuredClone(item));
  }

  async listItems(tenantId: string, filter: { status?: ReviewStatus; documentId?: string } = {}): Promise<QueueItem[]> {
    return [...this.items.values()]
      .filter(
        (i) =>
          i.tenantId === tenantId &&
          (filter.status === undefined || i.status === filter.status) &&
          (filter.documentId === undefined || i.documentId === filter.documentId),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((i) => structuredClone(i));
  }

  async summary(tenantId: string): Promise<QueueSummary> {
    const counts = { ...EMPTY_COUNTS };
    let lessonsApplied = 0;
    let oldestPendingAt: string | null = null;
    for (const item of this.items.values()) {
      if (item.tenantId !== tenantId) continue;
      counts[item.status] += 1;
      if (item.appliedLessonId) lessonsApplied += 1;
      if (item.status === "pending" && (oldestPendingAt === null || item.createdAt < oldestPendingAt)) {
        oldestPendingAt = item.createdAt;
      }
    }
    return { counts, lessonsApplied, oldestPendingAt };
  }

  async saveLesson(lesson: Lesson): Promise<void> {
    this.lessons.set(lesson.id, structuredClone(lesson));
  }

  async listLessons(tenantId: string): Promise<Lesson[]> {
    return [...this.lessons.values()]
      .filter((l) => l.tenantId === tenantId)
      .map((l) => structuredClone(l));
  }

  async findLessonByPattern(tenantId: string, pattern: string): Promise<Lesson | null> {
    for (const lesson of this.lessons.values()) {
      if (lesson.tenantId === tenantId && lesson.pattern === pattern) return structuredClone(lesson);
    }
    return null;
  }
}
