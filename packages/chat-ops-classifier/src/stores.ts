import type { AuditEvent, ExpenseDraft, ExpenseStatus, Task, TaskStatus, TimelineEntry } from "./types.js";

/**
 * Persistence boundaries, all scoped by projectId. In-memory implementations
 * below; `sql/001_schema.sql` has the equivalent tables for Postgres.
 */
export interface TimelineStore {
  append(entry: TimelineEntry): Promise<void>;
  /** Newest first. */
  list(projectId: string, filter?: { since?: string }): Promise<TimelineEntry[]>;
}

export interface TaskStore {
  insert(task: Task): Promise<void>;
  get(projectId: string, id: string): Promise<Task | null>;
  update(task: Task): Promise<void>;
  /** Oldest first. */
  list(projectId: string, status?: TaskStatus): Promise<Task[]>;
}

export interface ExpenseStore {
  insert(draft: ExpenseDraft): Promise<void>;
  get(projectId: string, id: string): Promise<ExpenseDraft | null>;
  update(draft: ExpenseDraft): Promise<void>;
  /** Oldest first. */
  list(projectId: string, status?: ExpenseStatus): Promise<ExpenseDraft[]>;
}

export interface AuditStore {
  append(event: AuditEvent): Promise<void>;
  /** Oldest first. `projectId` undefined returns everything (including unregistered-chat events, which have no project). */
  list(projectId?: string | null): Promise<AuditEvent[]>;
}

export interface Stores {
  timeline: TimelineStore;
  tasks: TaskStore;
  expenses: ExpenseStore;
  audit: AuditStore;
}

class InMemoryTimeline implements TimelineStore {
  private readonly rows: TimelineEntry[] = [];
  async append(entry: TimelineEntry): Promise<void> {
    this.rows.push(structuredClone(entry));
  }
  async list(projectId: string, filter: { since?: string } = {}): Promise<TimelineEntry[]> {
    // Reverse before the (stable) sort so entries with the same timestamp come out newest-inserted first.
    return [...this.rows]
      .reverse()
      .filter((r) => r.projectId === projectId && (filter.since === undefined || r.at >= filter.since))
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((r) => structuredClone(r));
  }
}

class InMemoryTasks implements TaskStore {
  private readonly rows = new Map<string, Task>();
  async insert(task: Task): Promise<void> {
    this.rows.set(task.id, structuredClone(task));
  }
  async get(projectId: string, id: string): Promise<Task | null> {
    const t = this.rows.get(id);
    return t && t.projectId === projectId ? structuredClone(t) : null;
  }
  async update(task: Task): Promise<void> {
    this.rows.set(task.id, structuredClone(task));
  }
  async list(projectId: string, status?: TaskStatus): Promise<Task[]> {
    return [...this.rows.values()]
      .filter((t) => t.projectId === projectId && (status === undefined || t.status === status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((t) => structuredClone(t));
  }
}

class InMemoryExpenses implements ExpenseStore {
  private readonly rows = new Map<string, ExpenseDraft>();
  async insert(draft: ExpenseDraft): Promise<void> {
    this.rows.set(draft.id, structuredClone(draft));
  }
  async get(projectId: string, id: string): Promise<ExpenseDraft | null> {
    const d = this.rows.get(id);
    return d && d.projectId === projectId ? structuredClone(d) : null;
  }
  async update(draft: ExpenseDraft): Promise<void> {
    this.rows.set(draft.id, structuredClone(draft));
  }
  async list(projectId: string, status?: ExpenseStatus): Promise<ExpenseDraft[]> {
    return [...this.rows.values()]
      .filter((d) => d.projectId === projectId && (status === undefined || d.status === status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((d) => structuredClone(d));
  }
}

class InMemoryAudit implements AuditStore {
  private readonly rows: AuditEvent[] = [];
  async append(event: AuditEvent): Promise<void> {
    this.rows.push(structuredClone(event));
  }
  async list(projectId?: string | null): Promise<AuditEvent[]> {
    return this.rows.filter((e) => projectId === undefined || e.projectId === projectId).map((e) => structuredClone(e));
  }
}

export function createInMemoryStores(): Stores {
  return { timeline: new InMemoryTimeline(), tasks: new InMemoryTasks(), expenses: new InMemoryExpenses(), audit: new InMemoryAudit() };
}
