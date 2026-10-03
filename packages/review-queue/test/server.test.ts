import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReviewServer } from "../src/server.js";
import { STATEMENT, makeService } from "./helpers.js";

const T = "company-a";

describe("HTTP server", () => {
  const h = makeService();
  const server = createReviewServer(h.service);
  let base = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("serves the review page", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Review queue");
  });

  it("requires a tenant on every data route", async () => {
    expect((await fetch(`${base}/queue`)).status).toBe(400);
    expect((await fetch(`${base}/metrics`)).status).toBe(400);
    expect((await post("/documents", { source: "s", text: STATEMENT })).status).toBe(400);
  });

  it("runs the whole loop: ingest, list, decide, measure", async () => {
    const ingest = await post("/documents", { tenantId: T, source: "api", text: STATEMENT });
    expect(ingest.status).toBe(201);
    const { items } = (await ingest.json()) as { items: Array<{ id: string; line: { description: string } }> };
    expect(items).toHaveLength(5);

    const queue = (await (await fetch(`${base}/queue?tenant=${T}&status=pending`)).json()) as { items: unknown[] };
    expect(queue.items).toHaveLength(5);

    const project = items.find((i) => i.line.description.includes("project"))!;
    expect((await post(`/items/${items[0]!.id}/approve`, { tenantId: T, reviewer: "dana" })).status).toBe(200);
    expect((await post(`/items/${project.id}/correct`, { tenantId: T, reviewer: "dana", category: "capital-improvement" })).status).toBe(200);
    expect((await post(`/items/${items[3]!.id}/reject`, { tenantId: T, reviewer: "dana", reason: "transfer" })).status).toBe(200);
    expect((await post(`/items/${items[3]!.id}/reject`, { tenantId: T, reviewer: "dana", reason: "again" })).status).toBe(409);
    expect((await post(`/items/nope/approve`, { tenantId: T, reviewer: "dana" })).status).toBe(404);
    expect((await post(`/items/${items[4]!.id}/approve`, { tenantId: "company-b", reviewer: "dana" })).status).toBe(404);

    const metrics = (await (await fetch(`${base}/metrics?tenant=${T}`)).json()) as { reviewed: number; lessons: number };
    expect(metrics).toMatchObject({ reviewed: 3, lessons: 1 });

    const health = await fetch(`${base}/health?tenant=${T}`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { status: string }).status).toBe("ok");
  });

  it("answers 503 on /health when the pipeline is broken and 502 on a failed ingest", async () => {
    const failed = await post("/documents", { tenantId: "company-c", source: "api", text: "not a statement at all" });
    expect(failed.status).toBe(502);
    const health = await fetch(`${base}/health?tenant=company-c`);
    expect(health.status).toBe(503);
    expect(((await health.json()) as { status: string }).status).toBe("broken");
  });

  it("rejects malformed bodies and unknown routes", async () => {
    const bad = await fetch(`${base}/documents`, { method: "POST", body: "{not json" });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/queue?tenant=${T}&status=weird`)).status).toBe(400);
    expect((await fetch(`${base}/nothing`)).status).toBe(404);
  });
});
