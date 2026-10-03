import { describe, expect, it } from "vitest";
import { ReviewError } from "../src/types.js";
import { DAY, FailingExtractor, STATEMENT, makeService } from "./helpers.js";

const T = "company-a";

describe("ingest", () => {
  it("records the document and enqueues every line as pending", async () => {
    const { service, store } = makeService();
    const result = await service.ingest({ tenantId: T, source: "email:statement", text: STATEMENT });

    expect(result.items).toHaveLength(5);
    expect(result.items.every((i) => i.status === "pending")).toBe(true);
    expect(result.lessonsApplied).toBe(0);

    const [doc] = await store.recentDocuments(T, 1);
    expect(doc).toMatchObject({ status: "processed", lineCount: 5, error: null });
    expect(await service.listQueue(T, { status: "pending" })).toHaveLength(5);
  });

  it("leaves a failed document behind when the extractor throws", async () => {
    const { service, store } = makeService(new FailingExtractor());
    await expect(service.ingest({ tenantId: T, source: "email:statement", text: "x" })).rejects.toMatchObject({
      code: "extraction_failed",
    });
    const [doc] = await store.recentDocuments(T, 1);
    expect(doc).toMatchObject({ status: "failed", error: "model timed out" });
  });

  it("rejects calls without a tenant", async () => {
    const { service } = makeService();
    await expect(service.ingest({ tenantId: "", source: "s", text: "" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(service.listQueue("")).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("review decisions", () => {
  it("approve keeps the suggestion and stamps the reviewer", async () => {
    const { service } = makeService();
    const { items } = await service.ingest({ tenantId: T, source: "s", text: STATEMENT });
    const rent = items[0]!;
    const approved = await service.approve(T, rent.id, "dana");
    expect(approved).toMatchObject({ status: "approved", reviewedBy: "dana", category: "rent-income", appliedLessonId: null });
    expect(approved.line).toEqual(rent.line); // original model output untouched
  });

  it("a reviewed item is immutable", async () => {
    const { service } = makeService();
    const { items } = await service.ingest({ tenantId: T, source: "s", text: STATEMENT });
    await service.approve(T, items[0]!.id, "dana");
    await expect(service.reject(T, items[0]!.id, "dana", "changed my mind")).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("correct creates a lesson from the description pattern", async () => {
    const { service, store } = makeService();
    const { items } = await service.ingest({ tenantId: T, source: "s", text: STATEMENT });
    const project = items.find((i) => i.line.description.includes("project"))!;
    expect(project.category).toBe("repairs");

    const corrected = await service.correct(T, project.id, "dana", { category: "capital-improvement", note: "engineering on a building is capex" });
    expect(corrected).toMatchObject({ status: "corrected", category: "capital-improvement", reviewNote: "engineering on a building is capex" });
    expect(corrected.line.suggestedCategory).toBe("repairs"); // what the model said stays on record

    const lessons = await store.listLessons(T);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ pattern: "engineering project structural unit", category: "capital-improvement", entityCode: null, sourceItemId: project.id });
  });

  it("a correction that changes nothing is refused", async () => {
    const { service } = makeService();
    const { items } = await service.ingest({ tenantId: T, source: "s", text: STATEMENT });
    await expect(service.correct(T, items[0]!.id, "dana", { category: "rent-income" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(service.correct(T, items[0]!.id, "dana", {})).rejects.toMatchObject({ code: "bad_request" });
  });

  it("reject needs a reason and does not create a lesson", async () => {
    const { service, store } = makeService();
    const { items } = await service.ingest({ tenantId: T, source: "s", text: STATEMENT });
    const transfer = items.find((i) => i.line.description.includes("Transfer"))!;
    await expect(service.reject(T, transfer.id, "dana", "")).rejects.toMatchObject({ code: "bad_request" });
    const rejected = await service.reject(T, transfer.id, "dana", "internal movement, not this company's cash flow");
    expect(rejected.status).toBe("rejected");
    expect(await store.listLessons(T)).toHaveLength(0);
  });
});

describe("lessons", () => {
  it("apply to the next similar line, which still arrives as pending", async () => {
    const { service, store } = makeService();
    const first = await service.ingest({ tenantId: T, source: "s", text: STATEMENT });
    const project = first.items.find((i) => i.line.description.includes("project"))!;
    await service.correct(T, project.id, "dana", { category: "capital-improvement" });

    const second = await service.ingest({
      tenantId: T,
      source: "s",
      text: ["2026-10-05 | Structural engineering project - unit 9 | -5100.00", "2026-10-06 | Rent received - unit 9 | 1200.00"].join("\n"),
    });
    expect(second.lessonsApplied).toBe(1);
    const [applied, untouched] = second.items;
    expect(applied).toMatchObject({ status: "pending", category: "capital-improvement", entityCode: "UNIT-009" });
    expect(applied!.appliedLessonId).toBe((await store.listLessons(T))[0]!.id);
    expect(applied!.line.suggestedCategory).toBe("repairs");
    expect(untouched).toMatchObject({ category: "rent-income", appliedLessonId: null });
    expect((await store.listLessons(T))[0]!.timesApplied).toBe(1);
  });

  it("the newest human decision on a pattern wins over the previous lesson", async () => {
    const { service, store } = makeService();
    const a = await service.ingest({ tenantId: T, source: "s", text: "2026-09-05 | Structural engineering project - unit 7 | -4800.00" });
    await service.correct(T, a.items[0]!.id, "dana", { category: "capital-improvement" });
    const b = await service.ingest({ tenantId: T, source: "s", text: "2026-10-05 | Structural engineering project - unit 8 | -300.00" });
    expect(b.items[0]!.category).toBe("capital-improvement");
    await service.correct(T, b.items[0]!.id, "lee", { category: "repairs", entityCode: "UNIT-008" });

    const lessons = await store.listLessons(T);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ category: "repairs", entityCode: "UNIT-008", sourceItemId: b.items[0]!.id });
  });

  it("never cross tenants", async () => {
    const { service } = makeService();
    const a = await service.ingest({ tenantId: "company-a", source: "s", text: "2026-09-05 | Structural engineering project - unit 7 | -4800.00" });
    await service.correct("company-a", a.items[0]!.id, "dana", { category: "capital-improvement" });

    const b = await service.ingest({ tenantId: "company-b", source: "s", text: "2026-09-05 | Structural engineering project - unit 7 | -4800.00" });
    expect(b.lessonsApplied).toBe(0);
    expect(b.items[0]!.category).toBe("repairs");

    // and an item id from one company is invisible to the other
    await expect(service.approve("company-b", a.items[0]!.id, "lee")).rejects.toMatchObject({ code: "not_found" });
    expect(await service.listQueue("company-b")).toHaveLength(1);
  });
});

describe("metrics", () => {
  it("reports null accuracy before any review, then approved / reviewed", async () => {
    const { service } = makeService();
    const { items } = await service.ingest({ tenantId: T, source: "s", text: STATEMENT });
    expect(await service.metrics(T)).toMatchObject({ pending: 5, reviewed: 0, firstPassAccuracy: null, lessons: 0 });

    await service.approve(T, items[0]!.id, "dana");
    await service.approve(T, items[1]!.id, "dana");
    await service.correct(T, items[2]!.id, "dana", { category: "capital-improvement" });
    await service.reject(T, items[3]!.id, "dana", "transfer");

    const m = await service.metrics(T);
    expect(m).toMatchObject({ pending: 1, approved: 2, corrected: 1, rejected: 1, reviewed: 4, lessons: 1, lessonsApplied: 0 });
    expect(m.firstPassAccuracy).toBeCloseTo(0.5);
    expect(m.oldestPendingAt).toBe(items[4]!.createdAt);
  });
});

describe("health", () => {
  it("is idle, not broken, when nothing ever arrived", async () => {
    const { service } = makeService();
    expect(await service.health(T)).toMatchObject({ status: "idle", lastDocument: null, daysSinceLastDocument: null });
  });

  it("is ok right after a processed document and idle after the threshold", async () => {
    const h = makeService();
    await h.service.ingest({ tenantId: T, source: "email:statement", text: STATEMENT });
    expect(await h.service.health(T)).toMatchObject({ status: "ok", daysSinceLastDocument: 0 });

    h.advance(12 * DAY);
    const report = await h.service.health(T, { idleAfterDays: 10 });
    expect(report.status).toBe("idle");
    expect(report.reason).toMatch(/check the sender/);
    expect(report.daysSinceLastDocument).toBe(12);
  });

  it("is broken when the last document failed, even if older ones were fine", async () => {
    const h = makeService();
    await h.service.ingest({ tenantId: T, source: "email:statement", text: STATEMENT });
    h.advance(DAY);
    await expect(h.service.ingest({ tenantId: T, source: "email:statement", text: "garbage" })).rejects.toBeInstanceOf(ReviewError);

    const report = await h.service.health(T);
    expect(report.status).toBe("broken");
    expect(report.reason).toMatch(/failed/);
    expect(report.recentFailures).toBe(1);
  });

  it("is broken when a document is stuck in received", async () => {
    const h = makeService();
    await h.store.insertDocument({
      id: "stuck", tenantId: T, source: "upload", receivedAt: new Date("2026-09-01T07:00:00.000Z").toISOString(),
      processedAt: null, status: "received", error: null, lineCount: 0,
    });
    expect((await h.service.health(T, { stuckAfterMinutes: 60 })).status).toBe("broken");
    expect((await h.service.health(T, { stuckAfterMinutes: 600 })).status).toBe("ok");
  });

  it("keeps tenants apart", async () => {
    const h = makeService();
    await h.service.ingest({ tenantId: "company-a", source: "s", text: STATEMENT });
    expect((await h.service.health("company-a")).status).toBe("ok");
    expect((await h.service.health("company-b")).status).toBe("idle");
  });
});
