import Anthropic from "@anthropic-ai/sdk";
import { LABELS, type Classification, type Classifier, type InboundMessage, type Label } from "./types.js";

/**
 * Optional LLM-backed classifier (requires the `@anthropic-ai/sdk` peer
 * dependency; key from `ANTHROPIC_API_KEY`). Same contract as the rule-based
 * one, so the pipeline and its tests never know which is wired in.
 */
export interface LlmClassifierOptions {
  model?: string;
  client?: Anthropic;
  /** One line about the operation, e.g. "residential construction site, 3 partners, 1 site manager". */
  context?: string;
}

const SYSTEM_PROMPT = `You label messages from an operations group chat (a construction site, a building under management, a small hotel). Exactly one label per message:

- progress: work done or being done, site photos, deliveries that arrived.
- pending: something that has not happened and someone must act on (missing material, a question waiting for an answer, a blocker).
- decision: an agreement or a choice that was made and others should rely on.
- invoice: a supplier invoice, bill or payment slip, usually as a photo or PDF.
- noise: greetings, thanks, emoji, chit-chat, anything with no operational content.

When in doubt between pending and progress, choose pending: a missed task costs more than a redundant one. Give a one-sentence reason a person could agree or disagree with.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string", enum: [...LABELS] },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["label", "confidence", "reason"],
  additionalProperties: false,
} as const;

export class LlmClassifier implements Classifier {
  readonly name = "llm";
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly context: string | undefined;

  constructor(options: LlmClassifierOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? process.env["ANTHROPIC_MODEL"] ?? "claude-opus-5-5";
    this.context = options.context;
  }

  async classify(message: InboundMessage): Promise<Classification> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096, // thinking tokens count against this; low effort keeps them short
      system: this.context ? `${SYSTEM_PROMPT}\n\nOperation: ${this.context}` : SYSTEM_PROMPT,
      // Classification is cheap work; keep effort at the low end of the adaptive range.
      output_config: { effort: "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      messages: [
        {
          role: "user",
          content: `kind: ${message.kind}\nhas attachment: ${message.mediaRef ? "yes" : "no"}\ntext: ${message.text?.trim() || "(none)"}`,
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      throw new Error(`model declined to classify (${response.stop_details?.category ?? "no category"})`);
    }
    const text = response.content.find((block) => block.type === "text")?.text ?? "";
    const parsed = JSON.parse(text) as { label?: unknown; confidence?: unknown; reason?: unknown };
    if (typeof parsed.label !== "string" || !(LABELS as readonly string[]).includes(parsed.label)) {
      throw new Error(`model returned an unknown label: ${String(parsed.label)}`);
    }
    return {
      label: parsed.label as Label,
      confidence: typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
      reason: typeof parsed.reason === "string" ? parsed.reason : "no reason given",
    };
  }
}
