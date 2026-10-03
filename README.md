# ai-ops-patterns

Two patterns for running a small company on AI agents without letting the agents run the company.

Both were rewritten from scratch, in TypeScript, from an internal hub that operates three businesses (a real-estate holding, a construction company and a hotel). The hub went from zero to production in six months, 1,100+ commits, and runs on one Mac Mini. Nothing from it is in this repository: no code, no prompts, no schemas, no data. The two packages here are the shape of what worked, with synthetic data, small enough to read in half an hour.

| Package | One line |
|---|---|
| [`packages/review-queue`](packages/review-queue) | **LLM extracts, humans keep the pen.** Documents in, structured lines out, every line waits for a human. Corrections become lessons; a health check tells "nothing arrived" from "something broke". |
| [`packages/chat-ops-classifier`](packages/chat-ops-classifier) | **The chat group is the system of record.** Messages from an operations group become a timeline, tasks and expense drafts, with an audit log of everything the bot did. Money is booked only when a partner says so. |

## Why these two

### A review queue instead of autopilot

The obvious design for "AI reads the bank statement" is: the model reads it and books the transactions. We did the opposite. The model produces lines, every line lands in a queue as `pending`, and a person approves, corrects or rejects it. On the first 411 reviewed lines the model was right 80.8% of the time: good enough to be useful, nowhere near good enough to be unattended. That number was only knowable because the queue kept the model's original output next to the human decision.

Three details carried most of the value:

1. **The queue row is the audit record.** A reviewed line never leaves the table; it keeps what the model said and what the human decided. Accuracy, by category, falls out of a `GROUP BY`.
2. **Corrections become lessons, applied forward.** A fix ("engineering project on a building is a capital improvement, not a repair") turns into a pattern that pre-corrects the next similar line. The next line still arrives as `pending`: a lesson improves the suggestion, it never approves anything. Rejections are kept as feedback but do not become auto-drop rules; in practice they were contextual judgement calls, and an automatic rule built from them is how real money goes missing.
3. **Health is three states, not two.** An empty review screen means either the sender did not send (call the sender) or the pipeline broke (call the engineer). The health check answers which, from the age and status of the last document.

With the queue making the work visible and batchable, a 2,156-line backlog was cleared in four weeks.

### The chat as the system of record

A construction site runs on a group chat: progress photos, "we still have no rebar", "let's go with the grey tiles", a photo of a supplier invoice. That information used to die in the scroll. The bot listens to the group, labels each message, and writes the records the business actually needs: a timeline, a task board, expense drafts. It is silent by default, answers `/status` and `/pending` when asked, and never decides anything with money in it: an invoice becomes a **draft**, a duplicate is flagged, and only a user with the `partner` role can confirm it, explicitly, in the group. Every action the bot takes, including the ones it refuses, is in the audit log with the actor and the reason.

## Architecture

```
review-queue

  document ──▶ Extractor ──▶ lines ──▶ LessonEngine ──▶ queue item (pending)
  (text)       mock | LLM              apply known            │
                                       corrections            ▼
                                                   human: approve │ correct │ reject
                                                                  │          │
                                                            metrics    lesson (forward only)

  health:  idle   = no document yet / sender silent for N days   → call the sender
           broken = last document failed, or stuck in "received" → call the engineer
           ok     = otherwise
```

```
chat-ops-classifier

  group chat ──▶ adapter ──▶ InboundMessage ──▶ Classifier ──▶ label
                (Telegram, ...)                 rules | LLM        │
                                                                   ▼
     progress, decision ─▶ timeline            pending ─▶ task (open → done)
     invoice ─▶ DocumentReader ─▶ expense DRAFT ─▶ duplicate check ─▶ /confirm, partner only
     noise ─▶ nothing stored (still audited)

     /status, /pending ─▶ summaries           every action ─▶ AuditLog (actor, reason)
```

Details, state machines and extension points: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it

Node 20 or newer. No database, no API key and no network are needed for the tests or the demo.

```bash
npm ci
npm run typecheck
npm test
npm run demo:review-queue      # http://localhost:8787 — paste a statement, review it, watch the lesson apply
```

Optional pieces, all opt-in through environment variables (names in [`.env.example`](.env.example)):

| Variable | Effect |
|---|---|
| `EXTRACTOR=anthropic` + `ANTHROPIC_API_KEY` | Use the LLM extractor instead of the deterministic mock (`@anthropic-ai/sdk` is an optional peer dependency). |
| `DATABASE_URL` | Use `PostgresStore` instead of memory. Apply `packages/review-queue/sql/001_schema.sql` first; `pg` is loaded only if asked for. |
| `IDLE_AFTER_DAYS` | Days without a document before `/health` reports `idle`. |

## Red lines

The hub runs under a short list of rules that no agent may cross. They are worth more than any prompt, so this repository shows where code, not goodwill, enforces each one:

| Rule | Where it lives here |
|---|---|
| **Never mix data between companies.** | Every store method takes a tenant / project id and never answers across it. An item id from company A is "not found" under company B, lessons learned in A never fire in B, a partner in one project is nobody in another. Tested. |
| **No financial action without the owner.** | A queue line becomes a booked transaction only through `approve`/`correct` by a named reviewer; lessons cannot approve. An expense draft is confirmed only by a `partner`, with an explicit `force` when it was flagged as a duplicate. There is no code path that confirms automatically. Tested. |
| **No message to third parties without confirmation.** | The pipeline returns text; it never sends. Replies go back to the same group that asked, and only on a command or a draft card. There is no outbound channel to anyone else. |
| **No schema change without a migration.** | Schemas ship as numbered SQL files (`sql/001_schema.sql`). Stores never create or alter tables at runtime. |

## What failed

Before the review queue, the hub had an autonomous task queue: agents that planned work, wrote code in isolated worktrees, opened pull requests and reviewed each other. It worked technically and was switched off within weeks because nobody fed it. The demand came from an operator sitting in an interactive session, and that session, with a human reading every diff, became the real executor. The lesson carried into both packages here: autonomy that is not pulled by a human loop is overhead with a nice dashboard, and the valuable automation is the one that shortens the human's decision, not the one that removes it.

## Honest limits

- Lesson matching is token overlap with a threshold. It is explainable and conservative; it will miss paraphrases. That is a deliberate trade.
- `PostgresStore` mirrors the in-memory store statement for statement but is not exercised by the unit tests. Run it against a real database before trusting it.
- The rule-based classifier is a fixture for tests and a fallback, not a product. The LLM classifier is the intended one.
- There is no authentication on the demo HTTP server. It is a demo.

## About the author

Thiago Bez is the Executive Director of HCB, a family-owned holding in Southern Brazil (commercial and residential real estate, a construction company and a hotel), and a board member of Beiramar Shopping. Since 2026 the holding's companies run on an in-house hub of AI agents that he designed and directs: statement intake with human review, a construction-site chat turned into timeline and expenses, 99 scheduled management routines. Before that, he directed fifteen political campaigns in six years, from governor to mayor, with teams of up to 35 people.

[linkedin.com/in/thiago-bez-68302311a](https://www.linkedin.com/in/thiago-bez-68302311a/)

## License

MIT, see [LICENSE](LICENSE).
