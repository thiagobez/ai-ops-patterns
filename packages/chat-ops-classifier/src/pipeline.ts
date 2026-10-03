import { randomBytes, randomUUID } from "node:crypto";
import { AuditLog, BOT_ACTOR } from "./audit-log.js";
import { parseCommand, type Command } from "./commands.js";
import type { Stores } from "./stores.js";
import {
  ChatOpsError,
  type Actor,
  type Classification,
  type Classifier,
  type Directory,
  type DocumentReader,
  type ExpenseDraft,
  type InboundMessage,
  type InvoiceFields,
  type Label,
  type Role,
  type Task,
  type TimelineEntry,
  type Transcriber,
} from "./types.js";

export interface PipelineDeps {
  classifier: Classifier;
  directory: Directory;
  stores: Stores;
  documentReader?: DocumentReader;
  transcriber?: Transcriber;
  now?: () => Date;
  newId?: () => string;
}

export type Effect =
  | { kind: "timeline"; id: string }
  | { kind: "task"; id: string }
  | { kind: "expense_draft"; id: string; duplicateOf: string | null };

export interface HandleResult {
  messageId: string;
  projectId: string | null;
  /** The label, or what short-circuited classification. */
  outcome: Label | "command" | "ignored" | "unclassified";
  /** Text the adapter should post back to the group, if any. The bot is silent by default. */
  reply: string | null;
  effects: Effect[];
}

const DAY_MS = 86_400_000;

/**
 * One message in, zero or more records out. Mutating methods (`confirmExpense`
 * and friends) are public so a dashboard can call them too, with the same
 * role checks the chat commands get.
 */
export class Pipeline {
  private readonly classifier: Classifier;
  private readonly directory: Directory;
  private readonly stores: Stores;
  private readonly documentReader: DocumentReader | undefined;
  private readonly transcriber: Transcriber | undefined;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly audit: AuditLog;

  constructor(deps: PipelineDeps) {
    this.classifier = deps.classifier;
    this.directory = deps.directory;
    this.stores = deps.stores;
    this.documentReader = deps.documentReader;
    this.transcriber = deps.transcriber;
    this.now = deps.now ?? (() => new Date());
    // Entity ids are short because people type them in chat commands.
    this.newId = deps.newId ?? (() => randomBytes(4).toString("hex"));
    // Audit ids are never typed by anyone, so they do not share that generator.
    this.audit = new AuditLog(deps.stores.audit, this.now, randomUUID);
  }

  async handle(message: InboundMessage): Promise<HandleResult> {
    const projectId = this.directory.projectOf(message.chatRef);
    const base = { messageId: message.id, projectId, reply: null, effects: [] as Effect[] };

    // A group nobody registered is not "probably fine": nothing from it is stored, and the silence is logged.
    if (!projectId) {
      await this.audit.record({
        projectId: null, actor: message.sender, action: "chat_not_registered", subjectType: "message", subjectId: message.id,
        detail: { channel: message.channel, chatRef: message.chatRef },
      });
      return { ...base, outcome: "ignored" };
    }

    const command = parseCommand(message.text ?? "");
    if (command) {
      const reply = await this.runCommand(projectId, message.sender, command, message.id);
      return { ...base, outcome: "command", reply };
    }

    let text = message.text;
    if (message.kind === "audio" && !text && message.mediaRef && this.transcriber) {
      text = await this.transcriber.transcribe(message.mediaRef);
    }
    const enriched: InboundMessage = text === undefined ? message : { ...message, text };

    let classification: Classification;
    try {
      classification = await this.classifier.classify(enriched);
    } catch (error) {
      // A message the model could not label is never dropped: it becomes a task so a human looks at it.
      const reason = error instanceof Error ? error.message : String(error);
      await this.audit.record({ projectId, actor: BOT_ACTOR, action: "classification_failed", subjectType: "message", subjectId: message.id, detail: { reason } });
      const task = await this.createTask(projectId, enriched, `Look at unclassified message from ${message.sender.name}: ${excerpt(text)}`);
      return { ...base, outcome: "unclassified", effects: [{ kind: "task", id: task.id }] };
    }

    await this.audit.record({
      projectId, actor: message.sender, action: "message_classified", subjectType: "message", subjectId: message.id,
      detail: { label: classification.label, confidence: classification.confidence, reason: classification.reason, classifier: this.classifier.name },
    });

    const effects: Effect[] = [];
    let reply: string | null = null;
    switch (classification.label) {
      case "progress":
      case "decision": {
        const entry = await this.appendTimeline(projectId, enriched, classification.label);
        effects.push({ kind: "timeline", id: entry.id });
        break;
      }
      case "pending": {
        const task = await this.createTask(projectId, enriched, excerpt(text));
        effects.push({ kind: "task", id: task.id });
        break;
      }
      case "invoice": {
        if (enriched.mediaRef && this.documentReader) {
          const draft = await this.createExpenseDraft(projectId, enriched, await this.documentReader.readInvoice(enriched.mediaRef));
          effects.push({ kind: "expense_draft", id: draft.id, duplicateOf: draft.duplicateOf });
          reply = draftCard(draft);
        } else {
          const task = await this.createTask(projectId, enriched, `Invoice mentioned without a readable attachment: ${excerpt(text)}`);
          effects.push({ kind: "task", id: task.id });
        }
        break;
      }
      case "noise":
        break;
    }
    return { ...base, outcome: classification.label, reply, effects };
  }

  /**
   * The only way an expense stops being a draft. Partner role, explicit call,
   * and a flagged duplicate must be acknowledged with `force`. There is no
   * code path that confirms automatically, and that is the point.
   */
  async confirmExpense(projectId: string, expenseId: string, actor: Actor, options: { force?: boolean } = {}): Promise<ExpenseDraft> {
    const draft = await this.stores.expenses.get(projectId, expenseId);
    if (!draft) throw new ChatOpsError("not_found", `expense ${expenseId} not found`);

    const role = this.directory.roleOf(projectId, actor.ref);
    if (role !== "partner") {
      await this.audit.record({
        projectId, actor, action: "expense_confirmation_denied", subjectType: "expense", subjectId: expenseId, detail: { role: role ?? "unknown" },
      });
      throw new ChatOpsError("forbidden", `only a partner can confirm an expense (you are ${role ?? "not a member"})`);
    }
    if (draft.status !== "draft") throw new ChatOpsError("invalid_transition", `expense ${expenseId} is already ${draft.status}`);
    if (draft.duplicateOf && !options.force) {
      throw new ChatOpsError("duplicate_unacknowledged", `expense ${expenseId} looks like a duplicate of ${draft.duplicateOf}; confirm with force to override`);
    }

    draft.status = "confirmed";
    draft.confirmedByRef = actor.ref;
    draft.confirmedAt = this.now().toISOString();
    await this.stores.expenses.update(draft);
    await this.audit.record({
      projectId, actor, action: "expense_confirmed", subjectType: "expense", subjectId: expenseId,
      detail: { amount: draft.amount, supplier: draft.supplier, forcedOverDuplicate: Boolean(draft.duplicateOf && options.force) },
    });
    return draft;
  }

  async discardExpense(projectId: string, expenseId: string, actor: Actor, reason: string): Promise<ExpenseDraft> {
    const draft = await this.stores.expenses.get(projectId, expenseId);
    if (!draft) throw new ChatOpsError("not_found", `expense ${expenseId} not found`);
    this.requireRole(projectId, actor, ["partner", "manager"], "discard an expense");
    if (draft.status !== "draft") throw new ChatOpsError("invalid_transition", `expense ${expenseId} is already ${draft.status}`);
    draft.status = "discarded";
    draft.discardedByRef = actor.ref;
    draft.discardedAt = this.now().toISOString();
    await this.stores.expenses.update(draft);
    await this.audit.record({ projectId, actor, action: "expense_discarded", subjectType: "expense", subjectId: expenseId, detail: { reason } });
    return draft;
  }

  async completeTask(projectId: string, taskId: string, actor: Actor): Promise<Task> {
    const task = await this.stores.tasks.get(projectId, taskId);
    if (!task) throw new ChatOpsError("not_found", `task ${taskId} not found`);
    this.requireRole(projectId, actor, ["partner", "manager", "worker"], "close a task");
    if (task.status === "done") throw new ChatOpsError("invalid_transition", `task ${taskId} is already done`);
    task.status = "done";
    task.doneAt = this.now().toISOString();
    task.doneByRef = actor.ref;
    await this.stores.tasks.update(task);
    await this.audit.record({ projectId, actor, action: "task_completed", subjectType: "task", subjectId: taskId });
    return task;
  }

  async status(projectId: string): Promise<string> {
    const since = new Date(this.now().getTime() - DAY_MS).toISOString();
    const [recent, openTasks, drafts, confirmed] = await Promise.all([
      this.stores.timeline.list(projectId, { since }),
      this.stores.tasks.list(projectId, "open"),
      this.stores.expenses.list(projectId, "draft"),
      this.stores.expenses.list(projectId, "confirmed"),
    ]);
    const progress = recent.filter((e) => e.kind === "progress").length;
    const decisions = recent.filter((e) => e.kind === "decision").length;
    const total = confirmed.reduce((sum, d) => sum + d.amount, 0);
    return [
      `Status for ${projectId}`,
      `Last 24h: ${progress} progress update(s), ${decisions} decision(s)`,
      `Open tasks: ${openTasks.length}`,
      `Expenses: ${drafts.length} draft(s) awaiting a partner, ${confirmed.length} confirmed (${money(total)})`,
    ].join("\n");
  }

  async pending(projectId: string): Promise<string> {
    const [openTasks, drafts] = await Promise.all([this.stores.tasks.list(projectId, "open"), this.stores.expenses.list(projectId, "draft")]);
    if (openTasks.length === 0 && drafts.length === 0) return "Nothing pending.";
    const lines: string[] = [];
    if (openTasks.length) {
      lines.push(`Open tasks (${openTasks.length}):`);
      for (const t of openTasks) lines.push(`- [${t.id}] ${t.title} (${t.createdByName}, ${age(t.createdAt, this.now())})`);
    }
    if (drafts.length) {
      lines.push(`Expense drafts awaiting a partner (${drafts.length}):`);
      for (const d of drafts) {
        lines.push(`- [${d.id}] ${d.supplier} ${money(d.amount)} due ${d.dueDate}${d.duplicateOf ? ` (possible duplicate of ${d.duplicateOf})` : ""}`);
      }
    }
    return lines.join("\n");
  }

  private async runCommand(projectId: string, actor: Actor, command: Command, messageId: string): Promise<string> {
    let reply: string;
    try {
      switch (command.name) {
        case "status":
          reply = await this.status(projectId);
          break;
        case "pending":
          reply = await this.pending(projectId);
          break;
        case "confirm": {
          const d = await this.confirmExpense(projectId, command.id, actor, { force: command.force });
          reply = `Confirmed expense ${d.id}: ${d.supplier} ${money(d.amount)} (by ${actor.name}).`;
          break;
        }
        case "discard": {
          const d = await this.discardExpense(projectId, command.id, actor, command.reason);
          reply = `Discarded expense ${d.id}.`;
          break;
        }
        case "done": {
          const t = await this.completeTask(projectId, command.id, actor);
          reply = `Task ${t.id} closed: ${t.title}`;
          break;
        }
        case "help":
          reply = "Commands: /status, /pending, /done <task>, /confirm <expense> [force], /discard <expense> <reason>";
          break;
      }
    } catch (error) {
      if (!(error instanceof ChatOpsError)) throw error;
      await this.audit.record({
        projectId, actor, action: "command_denied", subjectType: "command", subjectId: messageId, detail: { command: command.name, code: error.code },
      });
      return error.message;
    }
    await this.audit.record({ projectId, actor, action: "command_answered", subjectType: "command", subjectId: messageId, detail: { command: command.name } });
    return reply;
  }

  private requireRole(projectId: string, actor: Actor, allowed: Role[], verb: string): void {
    const role = this.directory.roleOf(projectId, actor.ref);
    if (!role || !allowed.includes(role)) {
      throw new ChatOpsError("forbidden", `only ${allowed.join("/")} can ${verb} (you are ${role ?? "not a member"})`);
    }
  }

  private async appendTimeline(projectId: string, m: InboundMessage, kind: "progress" | "decision"): Promise<TimelineEntry> {
    const entry: TimelineEntry = {
      id: this.newId(), projectId, kind, text: m.text?.trim() ?? "", authorRef: m.sender.ref, authorName: m.sender.name,
      at: m.sentAt, messageId: m.id, mediaRef: m.mediaRef ?? null,
    };
    await this.stores.timeline.append(entry);
    await this.audit.record({ projectId, actor: BOT_ACTOR, action: "timeline_appended", subjectType: "timeline", subjectId: entry.id, detail: { kind, messageId: m.id } });
    return entry;
  }

  private async createTask(projectId: string, m: InboundMessage, title: string): Promise<Task> {
    const task: Task = {
      id: this.newId(), projectId, title, status: "open", createdFromMessageId: m.id, createdByRef: m.sender.ref, createdByName: m.sender.name,
      createdAt: this.now().toISOString(), doneAt: null, doneByRef: null,
    };
    await this.stores.tasks.insert(task);
    await this.audit.record({ projectId, actor: BOT_ACTOR, action: "task_created", subjectType: "task", subjectId: task.id, detail: { messageId: m.id } });
    return task;
  }

  private async createExpenseDraft(projectId: string, m: InboundMessage, fields: InvoiceFields): Promise<ExpenseDraft> {
    const existing = await this.stores.expenses.list(projectId);
    const twin = existing.find((e) => e.status !== "discarded" && looksLikeSameInvoice(e, fields));
    const draft: ExpenseDraft = {
      ...fields,
      id: this.newId(), projectId, status: "draft", duplicateOf: twin?.id ?? null,
      createdFromMessageId: m.id, createdByRef: m.sender.ref, createdByName: m.sender.name, createdAt: this.now().toISOString(),
      confirmedByRef: null, confirmedAt: null, discardedByRef: null, discardedAt: null,
    };
    await this.stores.expenses.insert(draft);
    await this.audit.record({
      projectId, actor: BOT_ACTOR, action: "expense_draft_created", subjectType: "expense", subjectId: draft.id,
      detail: { messageId: m.id, supplier: draft.supplier, amount: draft.amount },
    });
    if (twin) {
      await this.audit.record({
        projectId, actor: BOT_ACTOR, action: "expense_duplicate_flagged", subjectType: "expense", subjectId: draft.id,
        detail: { duplicateOf: twin.id, rule: "same tax id, same amount, same invoice number or due date" },
      });
    }
    return draft;
  }
}

/** Same supplier (tax id), same amount, and either the same invoice number or the same due date. Explicit on purpose. */
function looksLikeSameInvoice(a: InvoiceFields, b: InvoiceFields): boolean {
  if (normalizeId(a.taxId) !== normalizeId(b.taxId)) return false;
  if (Math.round(a.amount * 100) !== Math.round(b.amount * 100)) return false;
  if (a.invoiceNumber && b.invoiceNumber) return normalizeId(a.invoiceNumber) === normalizeId(b.invoiceNumber);
  return a.dueDate === b.dueDate;
}

const normalizeId = (s: string): string => s.replace(/[^a-z0-9]/gi, "").toLowerCase();

function draftCard(d: ExpenseDraft): string {
  return [
    `Expense draft ${d.id}`,
    `${d.supplier} · tax id ${d.taxId}${d.invoiceNumber ? ` · invoice ${d.invoiceNumber}` : ""}`,
    `${money(d.amount)} due ${d.dueDate}`,
    ...(d.duplicateOf ? [`Warning: looks like a duplicate of ${d.duplicateOf}.`] : []),
    `Nothing is booked until a partner replies /confirm ${d.id}${d.duplicateOf ? " force" : ""}.`,
  ].join("\n");
}

function excerpt(text: string | undefined, max = 120): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t || "(no text)";
}

function money(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function age(iso: string, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS);
  return days <= 0 ? "today" : `${days}d ago`;
}
