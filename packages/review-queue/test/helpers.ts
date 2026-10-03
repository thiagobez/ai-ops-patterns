import { MockExtractor, type Extractor } from "../src/extractor.js";
import { InMemoryStore } from "../src/memory-store.js";
import { ReviewService } from "../src/review-service.js";

/** Deterministic service: fixed clock you can advance, sequential ids, mock extractor. */
export function makeService(extractor: Extractor = new MockExtractor()) {
  let clock = new Date("2026-09-01T09:00:00.000Z");
  let seq = 0;
  const store = new InMemoryStore();
  const service = new ReviewService({
    store,
    extractor,
    now: () => clock,
    newId: () => `id-${++seq}`,
  });
  return {
    service,
    store,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    set(iso: string) {
      clock = new Date(iso);
    },
  };
}

export const DAY = 86_400_000;

export const STATEMENT = [
  "# synthetic statement",
  "2026-09-02 | Rent received - unit 12 | 1500.00",
  "2026-09-03 | Condo fee - unit 12 | -320.00",
  "2026-09-05 | Structural engineering project - unit 7 | -4800.00",
  "2026-09-08 | Transfer to savings account | -2000.00",
  "2026-09-09 | Quarterly water bill | -140.50",
].join("\n");

export class FailingExtractor implements Extractor {
  readonly name = "failing";
  async extract(): Promise<never> {
    throw new Error("model timed out");
  }
}
