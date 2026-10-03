export * from "./types.js";
export { type Extractor, type ExtractionInput, MockExtractor } from "./extractor.js";
export { LessonEngine, normalize, patternOf, type LessonMatch, type LessonEngineOptions } from "./lesson-engine.js";
export { type QueueStore, type QueueSummary, EMPTY_COUNTS } from "./store.js";
export { InMemoryStore } from "./memory-store.js";
export { PostgresStore, type SqlClient } from "./postgres-store.js";
export { ReviewService, type ReviewServiceDeps } from "./review-service.js";
export { createReviewServer, type ServerOptions } from "./server.js";
// AnthropicExtractor is exported from its own module on purpose: importing it
// loads the SDK, which is an optional peer dependency.
