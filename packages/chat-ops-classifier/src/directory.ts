import type { Directory, Member, Role } from "./types.js";

/** Directory backed by plain config. Enough for a handful of groups; swap for a table when it is not. */
export class StaticDirectory implements Directory {
  private readonly chats: Map<string, string>;
  private readonly roles = new Map<string, Role>();

  constructor(config: { chats: Record<string, string>; members: Member[] }) {
    this.chats = new Map(Object.entries(config.chats));
    for (const m of config.members) this.roles.set(`${m.projectId}\u0000${m.ref}`, m.role);
  }

  projectOf(chatRef: string): string | null {
    return this.chats.get(chatRef) ?? null;
  }

  roleOf(projectId: string, senderRef: string): Role | null {
    return this.roles.get(`${projectId}\u0000${senderRef}`) ?? null;
  }
}
