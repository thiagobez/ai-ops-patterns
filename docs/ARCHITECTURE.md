# Architecture

Two independent packages in one npm workspace. They share conventions, not code: TypeScript strict, ESM, every use case behind an interface with an in-memory implementation, and the tenant (company or project) explicit on every call.

## review-queue

```
src/
  types.ts            domain types, ReviewError
  extractor.ts        Extractor interface + MockExtractor (deterministic)
  anthropic-extractor.ts  optional LLM extractor (separate module, loads the SDK)
  lesson-engine.ts    normalize / patternOf / LessonEngine (token-overlap matching)
  store.ts            QueueStore interface
  memory-store.ts     InMemoryStore
  postgres-store.ts   PostgresStore over a structural SqlClient (pg.Pool fits)
  review-service.ts   use cases: ingest, approve, correct, reject, metrics, health
  server.ts           node:http routes, JSON in/out, errors mapped by code
  main.ts             env-driven wiring for the demo
public/review.html    one static page that talks to the routes
sql/001_schema.sql    tables for PostgresStore
```

**Flow.** `ingest()` writes the document row as `received` *before* calling the extractor, so a model failure leaves a visible `failed` document instead of nothing. Lines come back, each is matched against the tenant's lessons, and the batch is inserted as `pending`. The document becomes `processed`.

**State machine.** `pending → approved | corrected | rejected`, one transition, by a named reviewer. Reviewed items are immutable (`invalid_transition` otherwise). The original `line` object is never updated; `category` and `entityCode` are the effective values.

**Lessons.** A correction computes `patternOf(description)` (sorted unique tokens after normalization) and upserts a lesson keyed by `(tenant, pattern)`. On ingest, `LessonEngine.match` picks the lesson with the highest Jaccard similarity above the threshold, requiring at least two shared tokens (or the whole pattern when it is shorter). A matched lesson overrides only the fields it knows (`null` means "nothing to say"), sets `appliedLessonId`, and bumps `timesApplied`. Lessons apply forward only; nothing re-labels existing pending items (a backfill would be a separate, dry-run-first job).

**Metrics.** `firstPassAccuracy = approved / (approved + corrected + rejected)`, `null` until the first review. Also backlog, oldest pending, lesson count and applications.

**Health.** Looks at the most recent documents only:

| Condition | Status | Who to call |
|---|---|---|
| no document for this tenant | `idle` | the sender |
| last document `failed` | `broken` | the engineer |
| last document `received` for longer than `stuckAfterMinutes` | `broken` | the engineer |
| last document older than `idleAfterDays` | `idle` | the sender |
| otherwise | `ok` (with a count of recent failures) | nobody |

`/health` answers 503 only for `broken`; `idle` is a 200 because it is not an outage.

**Tenant boundary.** The service takes `tenantId` on every method and passes it to every store call; the store never filters "all tenants". The HTTP layer has no default tenant.

**Extension points.** Another extractor: implement `Extractor`. Another database: implement `QueueStore` (14 methods). Another UI: the routes are plain JSON.

## chat-ops-classifier

```
src/
  types.ts            InboundMessage, labels, entities, Directory, errors
  classifier.ts       Classifier interface + MockClassifier (ordered rules, each with a reason)
  llm-classifier.ts   optional LLM classifier (separate module)
  document-reader.ts  DocumentReader interface + FixtureDocumentReader
  directory.ts        StaticDirectory: chat → project, (project, user) → role
  stores.ts           Timeline / Task / Expense / Audit store interfaces + in-memory
  audit-log.ts        AuditLog.record()
  commands.ts         parseCommand: /status /pending /done /confirm /discard /help
  pipeline.ts         handle(message) and the mutating use cases
  adapters/telegram.ts  interface-only example: platform payload → InboundMessage
sql/001_schema.sql    equivalent tables, optional
```

**Flow of `handle()`.**

1. `directory.projectOf(chatRef)`; unknown group → nothing stored, `chat_not_registered` audited, no reply.
2. Slash command → executed with the sender as actor; reply returned; `command_answered` or `command_denied` audited.
3. Audio without text → `Transcriber`, if one is wired.
4. `classifier.classify()`. A throw does not drop the message: it becomes a task ("look at unclassified message ...") and is audited as `classification_failed`.
5. By label: `progress`/`decision` → timeline; `pending` → open task; `invoice` with a readable attachment → expense draft + duplicate check + card asking for `/confirm`; `invoice` without one → task; `noise` → nothing.

**Expense state machine.** `draft → confirmed | discarded`. `confirmExpense` requires role `partner` in that project, a `draft` status, and `force: true` when `duplicateOf` is set. Denied attempts are audited with the role that tried. `discard` is `partner`/`manager`; closing a task is any member but `observer`. Roles are per project.

**Duplicate rule.** Same tax id (normalized), same amount to the cent, and either the same invoice number (when both have one) or the same due date, among non-discarded expenses of the project. The rule is written in one function so it can be read and argued with.

**Audit.** Every write and every refusal goes through `AuditLog.record()` with `projectId`, actor, action, subject and a `detail` object that includes the classifier's reason. Entity ids are short (people type them in chat); audit ids are UUIDs.

**Extension points.** A real channel: implement `ChannelAdapter` and map payloads like `fromTelegramUpdate` does; the pipeline never imports a bot library. A dashboard: call `confirmExpense` / `completeTask` directly; they carry the same role checks as the chat commands. Persistence: implement the four store interfaces (schema in `sql/`).

## Testing strategy

Everything runs in memory with injected clock and id generator, so tests are deterministic and need no network, database or key. The LLM-backed implementations are compiled (typecheck) but not executed in CI; they share the exact interface of the mocks, which is the point.
