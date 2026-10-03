import { describe, expect, it } from "vitest";
import { MockExtractor } from "../src/extractor.js";
import { ReviewError } from "../src/types.js";
import { STATEMENT } from "./helpers.js";

describe("MockExtractor", () => {
  const extractor = new MockExtractor();

  it("parses delimited lines and skips comments and headers", async () => {
    const lines = await extractor.extract({ text: STATEMENT });
    expect(lines).toHaveLength(5);
    expect(lines[0]).toEqual({
      date: "2026-09-02",
      description: "Rent received - unit 12",
      amount: 1500,
      suggestedCategory: "rent-income",
      suggestedEntityCode: "UNIT-012",
      confidence: 0.92,
    });
  });

  it("is deliberately unsure about engineering projects and blank on unknown lines", async () => {
    const lines = await extractor.extract({ text: STATEMENT });
    const project = lines.find((l) => l.description.includes("project"))!;
    expect(project.suggestedCategory).toBe("repairs");
    expect(project.confidence).toBeLessThan(0.6);
    const water = lines.find((l) => l.description.includes("water"))!;
    expect(water.suggestedCategory).toBeNull();
    expect(water.suggestedEntityCode).toBeNull();
  });

  it("returns no lines for an empty document and fails on an unparsable one", async () => {
    expect(await extractor.extract({ text: "   \n" })).toEqual([]);
    await expect(extractor.extract({ text: "this is a scanned page with no table" })).rejects.toBeInstanceOf(ReviewError);
  });
});
