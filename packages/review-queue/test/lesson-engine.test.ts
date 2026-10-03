import { describe, expect, it } from "vitest";
import { LessonEngine, normalize, patternOf } from "../src/lesson-engine.js";
import type { Lesson } from "../src/types.js";

function lesson(partial: Partial<Lesson> & Pick<Lesson, "id" | "pattern">): Lesson {
  return {
    tenantId: "t1",
    category: "capital-improvement",
    entityCode: null,
    sourceItemId: "x",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    timesApplied: 0,
    ...partial,
  };
}

describe("normalize / patternOf", () => {
  it("lowercases, strips accents, digits, punctuation and stopwords", () => {
    expect(normalize("Structural Engineering PROJECT - unit 7 (ref 2026/09)")).toEqual([
      "structural", "engineering", "project", "unit",
    ]);
  });

  it("produces the same pattern for lines that differ only by numbers and order", () => {
    expect(patternOf("Condo fee - unit 12")).toBe(patternOf("Unit 3: condo fee"));
  });
});

describe("LessonEngine.match", () => {
  const engine = new LessonEngine();
  const capex = lesson({ id: "L1", pattern: patternOf("Structural engineering project - unit 7") });

  it("matches the same kind of line with a different unit number", () => {
    const match = engine.match("Structural engineering project - unit 9", [capex]);
    expect(match?.lesson.id).toBe("L1");
    expect(match?.score).toBe(1);
    expect(match?.sharedTokens).toEqual(["engineering", "project", "structural", "unit"]);
  });

  it("does not fire on a loosely related line", () => {
    expect(engine.match("Rent received - unit 7", [capex])).toBeNull();
    expect(engine.match("Project management fee", [capex])).toBeNull();
  });

  it("never fires on a single shared generic token unless the pattern itself is one token", () => {
    const single = lesson({ id: "L2", pattern: "transfer", category: "transfer" });
    expect(engine.match("Transfer", [single])?.lesson.id).toBe("L2");
    expect(engine.match("Transfer to savings account", [single])).toBeNull(); // score 0.33 < threshold
  });

  it("prefers the highest score, then the most recently updated lesson", () => {
    const a = lesson({ id: "A", pattern: "engineering project structural unit", updatedAt: "2026-09-01T00:00:00.000Z" });
    const b = lesson({ id: "B", pattern: "engineering project structural unit", updatedAt: "2026-09-02T00:00:00.000Z" });
    const c = lesson({ id: "C", pattern: "engineering project", updatedAt: "2026-09-03T00:00:00.000Z" });
    expect(engine.match("Structural engineering project unit 1", [a, b, c])?.lesson.id).toBe("B");
  });

  it("explains a match in words a reviewer can check", () => {
    const match = engine.match("Structural engineering project - unit 2", [capex]);
    expect(engine.explain(match!)).toMatch(/lesson L1 matched with score 1\.00 on \[engineering, project, structural, unit\]/);
  });
});
