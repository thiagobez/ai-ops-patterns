import type { Classification, Classifier, InboundMessage } from "./types.js";

/**
 * Rule-based classifier for tests and as a fallback. Rules are ordered: the
 * first match wins, and each one says why, so the audit log reads like a
 * reviewer's note rather than a probability.
 */
const RULES: ReadonlyArray<{ label: Classification["label"]; test: RegExp; confidence: number; reason: string }> = [
  { label: "invoice", test: /\b(invoice|receipt|bill|tax invoice|payment slip)\b/i, confidence: 0.9, reason: "mentions an invoice or bill" },
  { label: "decision", test: /\b(decided|approved|agreed|go ahead|go with|we('| wi)ll use|let'?s use|final answer)\b/i, confidence: 0.85, reason: "records a decision" },
  { label: "pending", test: /\b(need|needs|missing|pending|blocked|waiting|still no|must|should|to ?do|asap|urgent|can someone|please)\b/i, confidence: 0.8, reason: "asks for something that has not happened yet" },
  { label: "progress", test: /\b(done|finished|completed|poured|installed|delivered|started|progress|today we|this morning|wrapped up)\b|\d{1,3}\s?%/i, confidence: 0.85, reason: "reports work done" },
  { label: "noise", test: /^\s*(ok(ay)?|thanks|thank you|thx|good (morning|afternoon|evening|night)|great|nice|perfect|got it|\p{Extended_Pictographic}+)\s*[.!]*\s*$/iu, confidence: 0.9, reason: "acknowledgement or greeting" },
];

export class MockClassifier implements Classifier {
  readonly name = "rules";

  async classify(message: InboundMessage): Promise<Classification> {
    const text = (message.text ?? "").trim();

    if (text.length === 0) {
      return message.kind === "photo"
        ? { label: "progress", confidence: 0.6, reason: "photo without caption, assumed site progress" }
        : { label: "noise", confidence: 0.7, reason: "empty message" };
    }
    if (text.length <= 3 && message.kind === "text") {
      return { label: "noise", confidence: 0.9, reason: "too short to carry information" };
    }
    for (const rule of RULES) {
      if (rule.test.test(text)) return { label: rule.label, confidence: rule.confidence, reason: rule.reason };
    }
    return message.kind === "photo"
      ? { label: "progress", confidence: 0.5, reason: "photo with a caption no rule matched, assumed site progress" }
      : { label: "noise", confidence: 0.4, reason: "no rule matched" };
  }
}
