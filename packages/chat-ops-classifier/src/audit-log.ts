import type { AuditStore } from "./stores.js";
import type { Actor, AuditAction, AuditEvent } from "./types.js";

export const BOT_ACTOR: Actor = { ref: "bot", name: "bot" };

/**
 * Append-only record of everything the bot did and why. Records are written
 * for denied actions too: "a worker tried to confirm an expense" is as
 * important to see as the confirmation itself.
 */
export class AuditLog {
  constructor(
    private readonly store: AuditStore,
    private readonly now: () => Date,
    private readonly newId: () => string,
  ) {}

  async record(input: {
    projectId: string | null;
    actor: Actor;
    action: AuditAction;
    subjectType: AuditEvent["subjectType"];
    subjectId: string;
    detail?: Record<string, unknown>;
  }): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: this.newId(),
      at: this.now().toISOString(),
      projectId: input.projectId,
      actorRef: input.actor.ref,
      actorName: input.actor.name,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      detail: input.detail ?? {},
    };
    await this.store.append(event);
    return event;
  }
}
