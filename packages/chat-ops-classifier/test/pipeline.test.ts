import { describe, expect, it } from "vitest";
import type { Classifier } from "../src/types.js";
import { CHAT, PROJECT, makePipeline, manager, partner, stranger, worker } from "./helpers.js";

describe("routing by label", () => {
  it("progress and decisions go to the timeline, nothing is posted back", async () => {
    const h = makePipeline();
    const r1 = await h.pipeline.handle(h.msg(worker, "Slab poured this morning", { kind: "photo", mediaRef: "p1" }));
    const r2 = await h.pipeline.handle(h.msg(partner, "We agreed to go with the grey tiles"));
    expect(r1).toMatchObject({ outcome: "progress", reply: null, effects: [{ kind: "timeline" }] });
    expect(r2).toMatchObject({ outcome: "decision", reply: null });

    const timeline = await h.stores.timeline.list(PROJECT);
    expect(timeline.map((e) => e.kind)).toEqual(["decision", "progress"]);
    expect(timeline[1]).toMatchObject({ authorName: "Omar", mediaRef: "p1", messageId: "m1" });
  });

  it("a pending message becomes an open task", async () => {
    const h = makePipeline();
    const r = await h.pipeline.handle(h.msg(worker, "Still no rebar on site, blocked until it arrives"));
    expect(r.outcome).toBe("pending");
    const tasks = await h.stores.tasks.list(PROJECT, "open");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Still no rebar on site, blocked until it arrives", createdByName: "Omar", status: "open" });
  });

  it("noise leaves no record besides the audit line", async () => {
    const h = makePipeline();
    await h.pipeline.handle(h.msg(worker, "Good morning!"));
    expect(await h.stores.timeline.list(PROJECT)).toHaveLength(0);
    expect(await h.stores.tasks.list(PROJECT)).toHaveLength(0);
    expect((await h.stores.audit.list(PROJECT)).map((e) => e.action)).toEqual(["message_classified"]);
  });

  it("an audio message is transcribed before classification", async () => {
    const h = makePipeline({ transcriber: { transcribe: async () => "we need two more pallets of blocks asap" } });
    const r = await h.pipeline.handle(h.msg(worker, undefined, { kind: "audio", mediaRef: "voice-1" }));
    expect(r.outcome).toBe("pending");
    expect((await h.stores.tasks.list(PROJECT))[0]?.title).toBe("we need two more pallets of blocks asap");
  });

  it("a message from an unregistered group is ignored, stored nowhere, and logged", async () => {
    const h = makePipeline();
    const r = await h.pipeline.handle(h.msg(worker, "Slab poured", { chatRef: "chat-unknown" }));
    expect(r).toMatchObject({ outcome: "ignored", projectId: null, reply: null, effects: [] });
    expect(await h.stores.timeline.list(PROJECT)).toHaveLength(0);
    const all = await h.stores.audit.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ action: "chat_not_registered", projectId: null, detail: { chatRef: "chat-unknown" } });
  });

  it("a classifier failure turns the message into a task instead of dropping it", async () => {
    const broken: Classifier = { name: "broken", classify: async () => { throw new Error("upstream 503"); } };
    const h = makePipeline({ classifier: broken });
    const r = await h.pipeline.handle(h.msg(worker, "windows arrived but two are cracked"));
    expect(r.outcome).toBe("unclassified");
    const tasks = await h.stores.tasks.list(PROJECT, "open");
    expect(tasks[0]?.title).toMatch(/unclassified message from Omar: windows arrived/);
    expect((await h.stores.audit.list(PROJECT)).map((e) => e.action)).toEqual(["classification_failed", "task_created"]);
  });
});

describe("invoices", () => {
  it("become an expense draft with a card asking a partner to confirm", async () => {
    const h = makePipeline();
    const r = await h.pipeline.handle(h.msg(worker, "Invoice from the concrete supplier", { kind: "photo", mediaRef: "photo-inv-1" }));
    expect(r.outcome).toBe("invoice");
    expect(r.effects).toEqual([{ kind: "expense_draft", id: "id1", duplicateOf: null }]);
    expect(r.reply).toContain("Northside Concrete Ltd");
    expect(r.reply).toContain("/confirm id1");

    const [draft] = await h.stores.expenses.list(PROJECT);
    expect(draft).toMatchObject({ status: "draft", amount: 3480, confirmedByRef: null, createdByName: "Omar" });
  });

  it("is never confirmed automatically, and never by a non-partner", async () => {
    const h = makePipeline();
    await h.pipeline.handle(h.msg(worker, "Invoice attached", { kind: "photo", mediaRef: "photo-inv-1" }));
    expect((await h.stores.expenses.list(PROJECT, "draft"))).toHaveLength(1);

    await expect(h.pipeline.confirmExpense(PROJECT, "id1", worker)).rejects.toMatchObject({ code: "forbidden" });
    await expect(h.pipeline.confirmExpense(PROJECT, "id1", manager)).rejects.toMatchObject({ code: "forbidden" });
    await expect(h.pipeline.confirmExpense(PROJECT, "id1", stranger)).rejects.toMatchObject({ code: "forbidden" });
    expect((await h.stores.expenses.get(PROJECT, "id1"))?.status).toBe("draft");

    const denied = (await h.stores.audit.list(PROJECT)).filter((e) => e.action === "expense_confirmation_denied");
    expect(denied.map((e) => e.detail["role"])).toEqual(["worker", "manager", "unknown"]);
  });

  it("is confirmed by a partner, once", async () => {
    const h = makePipeline();
    await h.pipeline.handle(h.msg(worker, "Invoice attached", { kind: "photo", mediaRef: "photo-inv-1" }));
    const confirmed = await h.pipeline.confirmExpense(PROJECT, "id1", partner);
    expect(confirmed).toMatchObject({ status: "confirmed", confirmedByRef: partner.ref, confirmedAt: "2026-09-10T12:00:00.000Z" });
    await expect(h.pipeline.confirmExpense(PROJECT, "id1", partner)).rejects.toMatchObject({ code: "invalid_transition" });
    expect((await h.stores.audit.list(PROJECT)).filter((e) => e.action === "expense_confirmed")).toHaveLength(1);
  });

  it("partner role does not travel between projects", async () => {
    const h = makePipeline();
    await h.pipeline.handle(h.msg(worker, "Invoice attached", { kind: "photo", mediaRef: "photo-inv-1" }));
    await expect(h.pipeline.confirmExpense("site-south", "id1", partner)).rejects.toMatchObject({ code: "not_found" });
    expect((await h.stores.expenses.get(PROJECT, "id1"))?.status).toBe("draft");
  });

  it("flags a duplicate and requires an explicit override to confirm it", async () => {
    const h = makePipeline();
    await h.pipeline.handle(h.msg(worker, "Invoice attached", { kind: "photo", mediaRef: "photo-inv-1" }));
    const again = await h.pipeline.handle(h.msg(manager, "invoice from concrete, resending", { kind: "photo", mediaRef: "photo-inv-1-again" }));
    expect(again.effects).toEqual([{ kind: "expense_draft", id: "id2", duplicateOf: "id1" }]);
    expect(again.reply).toMatch(/duplicate of id1/);

    await expect(h.pipeline.confirmExpense(PROJECT, "id2", partner)).rejects.toMatchObject({ code: "duplicate_unacknowledged" });
    const forced = await h.pipeline.confirmExpense(PROJECT, "id2", partner, { force: true });
    expect(forced.status).toBe("confirmed");

    const actions = (await h.stores.audit.list(PROJECT)).map((e) => e.action);
    expect(actions).toContain("expense_duplicate_flagged");
    expect((await h.stores.audit.list(PROJECT)).find((e) => e.action === "expense_confirmed")?.detail).toMatchObject({ forcedOverDuplicate: true });
  });

  it("does not flag a different invoice from the same supplier", async () => {
    const h = makePipeline();
    await h.pipeline.handle(h.msg(worker, "Invoice attached", { kind: "photo", mediaRef: "photo-inv-1" }));
    const other = await h.pipeline.handle(h.msg(worker, "Invoice attached", { kind: "photo", mediaRef: "photo-inv-2" }));
    expect(other.effects[0]).toMatchObject({ kind: "expense_draft", duplicateOf: null });
  });

  it("an invoice mentioned without a readable attachment becomes a task", async () => {
    const h = makePipeline();
    const r = await h.pipeline.handle(h.msg(worker, "the invoice for the crane is coming tomorrow"));
    expect(r.outcome).toBe("invoice");
    expect(r.effects[0]?.kind).toBe("task");
    expect((await h.stores.tasks.list(PROJECT))[0]?.title).toMatch(/^Invoice mentioned without a readable attachment/);
  });
});

describe("audit log", () => {
  it("records every bot action with actor and reason", async () => {
    const h = makePipeline();
    await h.pipeline.handle(h.msg(worker, "Slab poured"));
    await h.pipeline.handle(h.msg(worker, "need more sand please"));
    await h.pipeline.handle(h.msg(worker, "Invoice attached", { kind: "photo", mediaRef: "photo-inv-1" }));
    await h.pipeline.confirmExpense(PROJECT, "id3", partner);

    const events = await h.stores.audit.list(PROJECT);
    expect(events.map((e) => e.action)).toEqual([
      "message_classified", "timeline_appended",
      "message_classified", "task_created",
      "message_classified", "expense_draft_created",
      "expense_confirmed",
    ]);
    expect(events[0]).toMatchObject({ actorRef: worker.ref, subjectType: "message", detail: { label: "progress", classifier: "rules" } });
    expect(events[0]?.detail["reason"]).toBe("reports work done");
    expect(events.at(-1)).toMatchObject({ actorRef: partner.ref, actorName: "Dana", subjectId: "id3" });
    expect(events.every((e) => e.projectId === PROJECT && e.at && e.id)).toBe(true);
  });
});

describe("commands", () => {
  async function seeded() {
    const h = makePipeline();
    await h.pipeline.handle(h.msg(worker, "Slab poured this morning"));
    await h.pipeline.handle(h.msg(partner, "We agreed to go with the grey tiles"));
    await h.pipeline.handle(h.msg(worker, "Still no rebar on site, blocked"));
    await h.pipeline.handle(h.msg(worker, "Invoice attached", { kind: "photo", mediaRef: "photo-inv-1" }));
    return h;
  }

  it("/status summarises the last 24h, open tasks and expenses", async () => {
    const h = await seeded();
    const r = await h.pipeline.handle(h.msg(manager, "/status"));
    expect(r.outcome).toBe("command");
    expect(r.reply).toBe(
      ["Status for site-north", "Last 24h: 1 progress update(s), 1 decision(s)", "Open tasks: 1", "Expenses: 1 draft(s) awaiting a partner, 0 confirmed (0.00)"].join("\n"),
    );
    h.advance(2 * 86_400_000);
    expect((await h.pipeline.handle(h.msg(manager, "/status"))).reply).toContain("Last 24h: 0 progress update(s), 0 decision(s)");
  });

  it("/pending lists open tasks and drafts; /done and /confirm clear them", async () => {
    const h = await seeded();
    const pending = (await h.pipeline.handle(h.msg(worker, "/pending"))).reply!;
    expect(pending).toContain("Open tasks (1):");
    expect(pending).toContain("[id3] Still no rebar on site, blocked (Omar, today)");
    expect(pending).toContain("[id4] Northside Concrete Ltd 3,480.00 due 2026-09-30");

    expect((await h.pipeline.handle(h.msg(worker, "/done id3"))).reply).toBe("Task id3 closed: Still no rebar on site, blocked");
    expect((await h.pipeline.handle(h.msg(worker, "/confirm id4"))).reply).toMatch(/only a partner can confirm/);
    expect((await h.pipeline.handle(h.msg(partner, "/confirm id4"))).reply).toBe("Confirmed expense id4: Northside Concrete Ltd 3,480.00 (by Dana).");
    expect((await h.pipeline.handle(h.msg(worker, "/pending"))).reply).toBe("Nothing pending.");

    const commands = (await h.stores.audit.list(PROJECT)).filter((e) => e.subjectType === "command");
    expect(commands.map((e) => e.action)).toEqual(["command_answered", "command_answered", "command_denied", "command_answered", "command_answered"]);
  });

  it("strangers can read but not act; unknown slash text is just a message", async () => {
    const h = await seeded();
    expect((await h.pipeline.handle(h.msg(stranger, "/pending"))).reply).toContain("Open tasks");
    expect((await h.pipeline.handle(h.msg(stranger, "/done id3"))).reply).toMatch(/not a member/);
    expect((await h.pipeline.handle(h.msg(stranger, "/discard id4 wrong project"))).reply).toMatch(/only partner\/manager/);
    const r = await h.pipeline.handle(h.msg(worker, "/shrug done with the roof"));
    expect(r.outcome).toBe("progress");
  });

  it("addresses a specific bot and parses force", async () => {
    const h = await seeded();
    await h.pipeline.handle(h.msg(manager, "invoice again", { kind: "photo", mediaRef: "photo-inv-1-again" }));
    expect((await h.pipeline.handle(h.msg(partner, "/confirm@site_bot id5"))).reply).toMatch(/looks like a duplicate of id4/);
    expect((await h.pipeline.handle(h.msg(partner, "/confirm@site_bot id5 force"))).reply).toMatch(/^Confirmed expense id5/);
    expect(await h.stores.expenses.list(PROJECT, "confirmed")).toHaveLength(1);
    expect(CHAT).toBe("chat-100");
  });
});
