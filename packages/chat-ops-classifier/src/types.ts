/**
 * Core types for the chat-ops classifier.
 *
 * The chat group is where an operation actually happens: progress photos,
 * "we still need X", "let's go with option B", a photo of an invoice. The bot
 * turns that stream into records without ever becoming the decision maker:
 * money is only booked when a partner says so, in the group, explicitly.
 */

export type MessageKind = "text" | "photo" | "audio" | "document";

/** Platform-agnostic inbound message. Adapters (Telegram, WhatsApp, a test) produce this; the pipeline never sees a platform payload. */
export interface InboundMessage {
  /** Channel-scoped message reference. */
  id: string;
  channel: string;
  /** The group. One group is bound to exactly one project. */
  chatRef: string;
  sender: { ref: string; name: string };
  kind: MessageKind;
  /** Text body, caption, or transcript. */
  text?: string;
  /** Opaque handle the adapter can turn into bytes. */
  mediaRef?: string;
  sentAt: string;
}

export type Label = "progress" | "pending" | "decision" | "noise" | "invoice";

export const LABELS: readonly Label[] = ["progress", "pending", "decision", "noise", "invoice"];

export interface Classification {
  label: Label;
  confidence: number;
  /** Why. Shown in the audit log, so it has to make sense to a person. */
  reason: string;
}

export interface Classifier {
  readonly name: string;
  classify(message: InboundMessage): Promise<Classification>;
}

export interface Transcriber {
  transcribe(mediaRef: string): Promise<string>;
}

export interface InvoiceFields {
  supplier: string;
  taxId: string;
  amount: number;
  /** ISO date. */
  dueDate: string;
  invoiceNumber: string | null;
}

/** Reads the fields of an invoice out of an image or PDF. LLM vision in production, a fixture map in tests. */
export interface DocumentReader {
  readInvoice(mediaRef: string): Promise<InvoiceFields>;
}

export type Role = "partner" | "manager" | "worker" | "observer";

export interface Member {
  projectId: string;
  ref: string;
  name: string;
  role: Role;
}

/** Who is who, and which group belongs to which project. Roles are per project: a partner in one company is nobody in another. */
export interface Directory {
  projectOf(chatRef: string): string | null;
  roleOf(projectId: string, senderRef: string): Role | null;
}

export interface TimelineEntry {
  id: string;
  projectId: string;
  kind: "progress" | "decision";
  text: string;
  authorRef: string;
  authorName: string;
  at: string;
  messageId: string;
  mediaRef: string | null;
}

export type TaskStatus = "open" | "done";

export interface Task {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  createdFromMessageId: string;
  createdByRef: string;
  createdByName: string;
  createdAt: string;
  doneAt: string | null;
  doneByRef: string | null;
}

export type ExpenseStatus = "draft" | "confirmed" | "discarded";

export interface ExpenseDraft extends InvoiceFields {
  id: string;
  projectId: string;
  status: ExpenseStatus;
  /** Id of an earlier expense this one looks like. Set by the pipeline, acknowledged by a human. */
  duplicateOf: string | null;
  createdFromMessageId: string;
  createdByRef: string;
  createdByName: string;
  createdAt: string;
  confirmedByRef: string | null;
  confirmedAt: string | null;
  discardedByRef: string | null;
  discardedAt: string | null;
}

export type AuditAction =
  | "chat_not_registered"
  | "message_classified"
  | "classification_failed"
  | "timeline_appended"
  | "task_created"
  | "task_completed"
  | "expense_draft_created"
  | "expense_duplicate_flagged"
  | "expense_confirmed"
  | "expense_confirmation_denied"
  | "expense_discarded"
  | "command_answered"
  | "command_denied";

export interface AuditEvent {
  id: string;
  at: string;
  projectId: string | null;
  actorRef: string;
  actorName: string;
  action: AuditAction;
  subjectType: "message" | "timeline" | "task" | "expense" | "command";
  subjectId: string;
  detail: Record<string, unknown>;
}

export interface Actor {
  ref: string;
  name: string;
}

export type ChatOpsErrorCode = "not_found" | "forbidden" | "invalid_transition" | "duplicate_unacknowledged" | "bad_request";

export class ChatOpsError extends Error {
  constructor(
    readonly code: ChatOpsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChatOpsError";
  }
}
