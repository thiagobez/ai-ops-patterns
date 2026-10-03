import { MockClassifier } from "../src/classifier.js";
import { StaticDirectory } from "../src/directory.js";
import { FixtureDocumentReader } from "../src/document-reader.js";
import { Pipeline, type PipelineDeps } from "../src/pipeline.js";
import { createInMemoryStores } from "../src/stores.js";
import type { InboundMessage, InvoiceFields, MessageKind } from "../src/types.js";

export const PROJECT = "site-north";
export const CHAT = "chat-100";

export const partner = { ref: "u-1", name: "Dana" };
export const manager = { ref: "u-2", name: "Lee" };
export const worker = { ref: "u-3", name: "Omar" };
export const stranger = { ref: "u-9", name: "Someone" };

export const INVOICES: Record<string, InvoiceFields> = {
  "photo-inv-1": { supplier: "Northside Concrete Ltd", taxId: "TAX-55-0001", amount: 3480, dueDate: "2026-09-30", invoiceNumber: "A-1001" },
  "photo-inv-1-again": { supplier: "Northside Concrete", taxId: "tax 55 0001", amount: 3480.0, dueDate: "2026-09-30", invoiceNumber: "A1001" },
  "photo-inv-2": { supplier: "Brightline Electrical", taxId: "TAX-77-0002", amount: 920.5, dueDate: "2026-10-05", invoiceNumber: null },
};

export function makePipeline(overrides: Partial<PipelineDeps> = {}) {
  let clock = new Date("2026-09-10T12:00:00.000Z");
  let seq = 0;
  const stores = createInMemoryStores();
  const pipeline = new Pipeline({
    classifier: new MockClassifier(),
    directory: new StaticDirectory({
      chats: { [CHAT]: PROJECT, "chat-200": "site-south" },
      members: [
        { projectId: PROJECT, ...partner, role: "partner" },
        { projectId: PROJECT, ...manager, role: "manager" },
        { projectId: PROJECT, ...worker, role: "worker" },
        // Dana is a partner at site-north only.
        { projectId: "site-south", ...partner, role: "observer" },
      ],
    }),
    stores,
    documentReader: new FixtureDocumentReader(INVOICES),
    now: () => clock,
    newId: () => `id${++seq}`,
    ...overrides,
  });
  let msgSeq = 0;
  return {
    pipeline,
    stores,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    msg(sender: { ref: string; name: string }, text: string | undefined, extra: { kind?: MessageKind; mediaRef?: string; chatRef?: string } = {}): InboundMessage {
      return {
        id: `m${++msgSeq}`,
        channel: "test",
        chatRef: extra.chatRef ?? CHAT,
        sender,
        kind: extra.kind ?? "text",
        ...(text !== undefined && { text }),
        ...(extra.mediaRef !== undefined && { mediaRef: extra.mediaRef }),
        sentAt: clock.toISOString(),
      };
    },
  };
}
