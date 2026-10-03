import Anthropic from "@anthropic-ai/sdk";
import type { Extractor, ExtractionInput } from "./extractor.js";
import { ReviewError, type ExtractedLine } from "./types.js";

/**
 * Optional LLM-backed extractor. Requires the `@anthropic-ai/sdk` peer
 * dependency; the key is read by the SDK from `ANTHROPIC_API_KEY` (or an
 * `ant auth login` profile). Nothing here is used by the test suite.
 */
export interface AnthropicExtractorOptions {
  /** Defaults to `ANTHROPIC_MODEL` or `claude-opus-5-5`. */
  model?: string;
  /** Inject a configured client (custom base URL, retries, tests). */
  client?: Anthropic;
  /** Categories the model may choose from. Anything else comes back as null for the human to fill. */
  categories?: readonly string[];
}

const SYSTEM_PROMPT = `You extract transaction lines from financial documents (bank statements, property management reports, expense summaries) into structured JSON.

Rules:
- One output line per transaction in the document. Do not merge, split or invent lines.
- date is ISO (YYYY-MM-DD). If only day and month appear, infer the year from context in the document; if impossible, use the most recent plausible date and lower the confidence.
- amount is a signed number in currency units: money in is positive, money out is negative.
- suggestedCategory must be one of the allowed categories, or null when none clearly applies. Do not guess a category from the sign of the amount; a transfer between accounts is a transfer, not income or expense.
- suggestedEntityCode is the unit, apartment, contract or cost-centre identifier the line refers to, as printed in the document, or null.
- confidence is your own estimate, 0 to 1, per line.
Your output goes into a human review queue; it is better to leave a field null than to fill it with a guess.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          description: { type: "string" },
          amount: { type: "number" },
          suggestedCategory: { type: ["string", "null"] },
          suggestedEntityCode: { type: ["string", "null"] },
          confidence: { type: "number" },
        },
        required: ["date", "description", "amount", "suggestedCategory", "suggestedEntityCode", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["lines"],
  additionalProperties: false,
} as const;

export class AnthropicExtractor implements Extractor {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly categories: readonly string[] | undefined;

  constructor(options: AnthropicExtractorOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? process.env["ANTHROPIC_MODEL"] ?? "claude-opus-5-5";
    this.categories = options.categories;
  }

  async extract(input: ExtractionInput): Promise<ExtractedLine[]> {
    const categoriesNote = this.categories?.length
      ? `Allowed categories: ${this.categories.join(", ")}.`
      : "Allowed categories: use short lowercase slugs such as rent-income, condo-fee, property-tax, insurance, management-fee, transfer, repairs, capital-improvement.";
    const hintNote = input.hint ? `Context: ${input.hint}.` : "";

    // Streaming keeps long statements from tripping request timeouts.
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 32_000,
      system: SYSTEM_PROMPT,
      // Thinking is always on for this model family; effort is the only knob and
      // extraction does not need the deep end of it.
      output_config: { effort: "medium", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      messages: [
        {
          role: "user",
          content: `${categoriesNote}\n${hintNote}\n\n<document>\n${input.text}\n</document>`,
        },
      ],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      throw new ReviewError("extraction_failed", `model declined the request (${message.stop_details?.category ?? "no category"})`);
    }
    if (message.stop_reason === "max_tokens") {
      throw new ReviewError("extraction_failed", "model output truncated at max_tokens; split the document");
    }

    const text = message.content.find((block) => block.type === "text")?.text ?? "";
    return parseLines(text);
  }
}

/** Runtime check of the model output. Structured outputs enforce the schema; this guards against a drifting SDK or a proxy. */
function parseLines(text: string): ExtractedLine[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ReviewError("extraction_failed", "model output is not valid JSON", { cause: error });
  }
  const lines = (parsed as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) throw new ReviewError("extraction_failed", "model output has no lines array");
  return lines.map((raw, index) => {
    const r = raw as Record<string, unknown>;
    if (typeof r["date"] !== "string" || typeof r["description"] !== "string" || typeof r["amount"] !== "number") {
      throw new ReviewError("extraction_failed", `line ${index} is missing date, description or amount`);
    }
    return {
      date: r["date"],
      description: r["description"],
      amount: r["amount"],
      suggestedCategory: typeof r["suggestedCategory"] === "string" ? r["suggestedCategory"] : null,
      suggestedEntityCode: typeof r["suggestedEntityCode"] === "string" ? r["suggestedEntityCode"] : null,
      confidence: typeof r["confidence"] === "number" ? Math.min(1, Math.max(0, r["confidence"])) : 0.5,
    };
  });
}
