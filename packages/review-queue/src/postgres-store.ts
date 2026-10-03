import { EMPTY_COUNTS, type QueueStore, type QueueSummary } from "./store.js";
import type { Lesson, QueueItem, ReviewDocument, ReviewStatus } from "./types.js";

/**
 * The slice of a Postgres client this store needs. `pg.Pool` and `pg.Client`
 * satisfy it structurally, so `pg` is not a dependency of this package: pass
 * whatever pool your application already has. Schema: `sql/001_schema.sql`.
 */
export interface SqlClient {
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

/**
 * Same contract as InMemoryStore, one statement per method, every query
 * scoped by tenant_id. Not covered by the unit tests (they need no database);
 * run it against a real Postgres before trusting it in production.
 */
export class PostgresStore implements QueueStore {
  constructor(private readonly sql: SqlClient) {}

  async insertDocument(doc: ReviewDocument): Promise<void> {
    await this.sql.query(
      `insert into review_documents (id, tenant_id, source, received_at, processed_at, status, error, line_count)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [doc.id, doc.tenantId, doc.source, doc.receivedAt, doc.processedAt, doc.status, doc.error, doc.lineCount],
    );
  }

  async updateDocument(
    tenantId: string,
    id: string,
    patch: Partial<Pick<ReviewDocument, "status" | "processedAt" | "error" | "lineCount">>,
  ): Promise<void> {
    await this.sql.query(
      `update review_documents
         set status = coalesce($3, status),
             processed_at = coalesce($4, processed_at),
             error = coalesce($5, error),
             line_count = coalesce($6, line_count)
       where tenant_id = $1 and id = $2`,
      [tenantId, id, patch.status ?? null, patch.processedAt ?? null, patch.error ?? null, patch.lineCount ?? null],
    );
  }

  async recentDocuments(tenantId: string, limit: number): Promise<ReviewDocument[]> {
    const { rows } = await this.sql.query<DocumentRow>(
      `select * from review_documents where tenant_id = $1 order by received_at desc limit $2`,
      [tenantId, limit],
    );
    return rows.map(toDocument);
  }

  async insertItems(items: QueueItem[]): Promise<void> {
    for (const item of items) {
      await this.sql.query(
        `insert into review_items
           (id, tenant_id, document_id, line, status, category, entity_code, applied_lesson_id,
            reviewed_by, reviewed_at, review_note, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          item.id, item.tenantId, item.documentId, JSON.stringify(item.line), item.status, item.category,
          item.entityCode, item.appliedLessonId, item.reviewedBy, item.reviewedAt, item.reviewNote, item.createdAt,
        ],
      );
    }
  }

  async getItem(tenantId: string, id: string): Promise<QueueItem | null> {
    const { rows } = await this.sql.query<ItemRow>(`select * from review_items where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async updateItem(item: QueueItem): Promise<void> {
    // `line` is intentionally not in the update list: the original extraction is immutable.
    await this.sql.query(
      `update review_items
         set status = $3, category = $4, entity_code = $5, applied_lesson_id = $6,
             reviewed_by = $7, reviewed_at = $8, review_note = $9
       where tenant_id = $1 and id = $2`,
      [
        item.tenantId, item.id, item.status, item.category, item.entityCode, item.appliedLessonId,
        item.reviewedBy, item.reviewedAt, item.reviewNote,
      ],
    );
  }

  async listItems(tenantId: string, filter: { status?: ReviewStatus; documentId?: string } = {}): Promise<QueueItem[]> {
    const { rows } = await this.sql.query<ItemRow>(
      `select * from review_items
        where tenant_id = $1
          and ($2::text is null or status = $2)
          and ($3::text is null or document_id = $3)
        order by created_at, id`,
      [tenantId, filter.status ?? null, filter.documentId ?? null],
    );
    return rows.map(toItem);
  }

  async summary(tenantId: string): Promise<QueueSummary> {
    const { rows } = await this.sql.query<{ status: ReviewStatus; n: string; with_lesson: string; oldest_pending: string | null }>(
      `select status,
              count(*)::text as n,
              count(applied_lesson_id)::text as with_lesson,
              min(created_at) filter (where status = 'pending')::text as oldest_pending
         from review_items where tenant_id = $1 group by status`,
      [tenantId],
    );
    const counts = { ...EMPTY_COUNTS };
    let lessonsApplied = 0;
    let oldestPendingAt: string | null = null;
    for (const row of rows) {
      counts[row.status] = Number(row.n);
      lessonsApplied += Number(row.with_lesson);
      if (row.oldest_pending) oldestPendingAt = new Date(row.oldest_pending).toISOString();
    }
    return { counts, lessonsApplied, oldestPendingAt };
  }

  async saveLesson(lesson: Lesson): Promise<void> {
    await this.sql.query(
      `insert into review_lessons (id, tenant_id, pattern, category, entity_code, source_item_id, created_at, updated_at, times_applied)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (id) do update
         set category = excluded.category, entity_code = excluded.entity_code, source_item_id = excluded.source_item_id,
             updated_at = excluded.updated_at, times_applied = excluded.times_applied`,
      [
        lesson.id, lesson.tenantId, lesson.pattern, lesson.category, lesson.entityCode, lesson.sourceItemId,
        lesson.createdAt, lesson.updatedAt, lesson.timesApplied,
      ],
    );
  }

  async listLessons(tenantId: string): Promise<Lesson[]> {
    const { rows } = await this.sql.query<LessonRow>(`select * from review_lessons where tenant_id = $1 order by created_at`, [tenantId]);
    return rows.map(toLesson);
  }

  async findLessonByPattern(tenantId: string, pattern: string): Promise<Lesson | null> {
    const { rows } = await this.sql.query<LessonRow>(`select * from review_lessons where tenant_id = $1 and pattern = $2`, [tenantId, pattern]);
    return rows[0] ? toLesson(rows[0]) : null;
  }
}

interface DocumentRow {
  id: string; tenant_id: string; source: string; received_at: string | Date; processed_at: string | Date | null;
  status: ReviewDocument["status"]; error: string | null; line_count: number;
}
interface ItemRow {
  id: string; tenant_id: string; document_id: string; line: QueueItem["line"] | string; status: ReviewStatus;
  category: string | null; entity_code: string | null; applied_lesson_id: string | null; reviewed_by: string | null;
  reviewed_at: string | Date | null; review_note: string | null; created_at: string | Date;
}
interface LessonRow {
  id: string; tenant_id: string; pattern: string; category: string | null; entity_code: string | null;
  source_item_id: string; created_at: string | Date; updated_at: string | Date; times_applied: number;
}

const iso = (v: string | Date): string => (v instanceof Date ? v : new Date(v)).toISOString();
const isoOrNull = (v: string | Date | null): string | null => (v === null ? null : iso(v));

function toDocument(r: DocumentRow): ReviewDocument {
  return {
    id: r.id, tenantId: r.tenant_id, source: r.source, receivedAt: iso(r.received_at), processedAt: isoOrNull(r.processed_at),
    status: r.status, error: r.error, lineCount: Number(r.line_count),
  };
}

function toItem(r: ItemRow): QueueItem {
  return {
    id: r.id, tenantId: r.tenant_id, documentId: r.document_id,
    line: typeof r.line === "string" ? (JSON.parse(r.line) as QueueItem["line"]) : r.line,
    status: r.status, category: r.category, entityCode: r.entity_code, appliedLessonId: r.applied_lesson_id,
    reviewedBy: r.reviewed_by, reviewedAt: isoOrNull(r.reviewed_at), reviewNote: r.review_note, createdAt: iso(r.created_at),
  };
}

function toLesson(r: LessonRow): Lesson {
  return {
    id: r.id, tenantId: r.tenant_id, pattern: r.pattern, category: r.category, entityCode: r.entity_code,
    sourceItemId: r.source_item_id, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), timesApplied: Number(r.times_applied),
  };
}
