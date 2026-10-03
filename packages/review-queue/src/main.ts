import { AnthropicExtractor } from "./anthropic-extractor.js";
import { MockExtractor, type Extractor } from "./extractor.js";
import { InMemoryStore } from "./memory-store.js";
import { PostgresStore, type SqlClient } from "./postgres-store.js";
import { ReviewService } from "./review-service.js";
import { createReviewServer } from "./server.js";
import type { QueueStore } from "./store.js";

/**
 * Demo entry point, wired from environment variables (see `.env.example`).
 * With nothing set it runs in memory with the mock extractor, which is enough
 * to click through the review page.
 */
async function main(): Promise<void> {
  const port = Number(process.env["PORT"] ?? 8787);
  const store = await pickStore();
  const extractor = pickExtractor();
  const service = new ReviewService({ store, extractor });
  const server = createReviewServer(service, { idleAfterDays: Number(process.env["IDLE_AFTER_DAYS"] ?? 10) });

  server.listen(port, () => {
    console.log(`review-queue listening on http://localhost:${port} (store=${store.constructor.name}, extractor=${extractor.name})`);
  });
}

function pickExtractor(): Extractor {
  if (process.env["EXTRACTOR"] === "anthropic") {
    if (!process.env["ANTHROPIC_API_KEY"]) throw new Error("EXTRACTOR=anthropic needs ANTHROPIC_API_KEY in the environment");
    return new AnthropicExtractor();
  }
  return new MockExtractor();
}

async function pickStore(): Promise<QueueStore> {
  const url = process.env["DATABASE_URL"];
  if (!url) return new InMemoryStore();
  // `pg` is not a dependency of this package; load it only when asked for.
  const moduleName = "pg";
  const pg = (await import(moduleName)) as { default?: { Pool: new (o: { connectionString: string }) => SqlClient }; Pool?: new (o: { connectionString: string }) => SqlClient };
  const Pool = pg.Pool ?? pg.default?.Pool;
  if (!Pool) throw new Error("DATABASE_URL is set but the pg package is not installed (npm i pg)");
  return new PostgresStore(new Pool({ connectionString: url }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
