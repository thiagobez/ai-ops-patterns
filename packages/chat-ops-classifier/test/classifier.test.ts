import { describe, expect, it } from "vitest";
import { MockClassifier } from "../src/classifier.js";
import type { InboundMessage, Label } from "../src/types.js";

const base: InboundMessage = { id: "m", channel: "test", chatRef: "c", sender: { ref: "u", name: "U" }, kind: "text", sentAt: "2026-09-10T12:00:00.000Z" };

describe("MockClassifier", () => {
  const classifier = new MockClassifier();
  const cases: Array<[string, Partial<InboundMessage>, Label]> = [
    ["Slab poured this morning, curing now", {}, "progress"],
    ["Facade is at 60% as of today", {}, "progress"],
    ["Still no rebar on site, blocked until it arrives", {}, "pending"],
    ["Can someone call the supplier about the window frames?", {}, "pending"],
    ["We agreed to go with the grey tiles for the lobby", {}, "decision"],
    ["Invoice from the concrete supplier attached", { kind: "photo", mediaRef: "p1" }, "invoice"],
    ["ok", {}, "noise"],
    ["Good morning!", {}, "noise"],
    ["👍", {}, "noise"],
    ["", { kind: "photo", mediaRef: "p2" }, "progress"],
  ];

  it.each(cases)("labels %j", async (text, extra, expected) => {
    const result = await classifier.classify({ ...base, ...extra, text });
    expect(result.label).toBe(expected);
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("falls back to noise with low confidence when nothing matches", async () => {
    const result = await classifier.classify({ ...base, text: "the weather forecast mentions clouds" });
    expect(result).toMatchObject({ label: "noise", confidence: 0.4 });
  });
});
