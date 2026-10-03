import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ReviewService } from "./review-service.js";
import { ReviewError, type ReviewErrorCode, type ReviewStatus } from "./types.js";

/**
 * Minimal HTTP surface on `node:http`: no framework, one file, every route
 * maps to one service method. Tenant is explicit on every call (query
 * `tenant` on GET, body `tenantId` on POST); there is no default tenant.
 *
 *   GET  /                         review page
 *   POST /documents                { tenantId, source, text, hint? }
 *   GET  /queue?tenant=&status=
 *   POST /items/:id/approve        { tenantId, reviewer }
 *   POST /items/:id/correct        { tenantId, reviewer, category?, entityCode?, note? }
 *   POST /items/:id/reject         { tenantId, reviewer, reason }
 *   GET  /metrics?tenant=
 *   GET  /health?tenant=&idleAfterDays=
 */
export interface ServerOptions {
  /** Path of the static review page. Defaults to the bundled `public/review.html`. */
  pagePath?: URL | string;
  /** Default `idleAfterDays` for /health. */
  idleAfterDays?: number;
  /** Max accepted request body in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
}

const STATUS_BY_CODE: Record<ReviewErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  invalid_transition: 409,
  extraction_failed: 502,
};

const STATUSES: ReadonlySet<string> = new Set<ReviewStatus>(["pending", "approved", "corrected", "rejected"]);

export function createReviewServer(service: ReviewService, options: ServerOptions = {}): Server {
  const pagePath = options.pagePath ?? new URL("../public/review.html", import.meta.url);
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;

  return createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      if (error instanceof ReviewError) {
        sendJson(res, STATUS_BY_CODE[error.code], { error: error.code, message: error.message });
      } else {
        sendJson(res, 500, { error: "internal", message: error instanceof Error ? error.message : "unknown error" });
      }
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(await readFile(pagePath, "utf8"));
      return;
    }
    if (method === "POST" && path === "/documents") {
      const body = await readJson(req, maxBodyBytes);
      const result = await service.ingest({
        tenantId: str(body, "tenantId"),
        source: str(body, "source"),
        text: str(body, "text"),
        ...(typeof body["hint"] === "string" && { hint: body["hint"] }),
      });
      sendJson(res, 201, result);
      return;
    }
    if (method === "GET" && path === "/queue") {
      const status = url.searchParams.get("status");
      if (status !== null && !STATUSES.has(status)) throw new ReviewError("bad_request", `unknown status ${status}`);
      const items = await service.listQueue(tenantParam(url), status ? { status: status as ReviewStatus } : {});
      sendJson(res, 200, { items });
      return;
    }
    const action = /^\/items\/([^/]+)\/(approve|correct|reject)$/.exec(path);
    if (method === "POST" && action) {
      const [, id, verb] = action as unknown as [string, string, "approve" | "correct" | "reject"];
      const body = await readJson(req, maxBodyBytes);
      const tenantId = str(body, "tenantId");
      const reviewer = str(body, "reviewer");
      const item =
        verb === "approve"
          ? await service.approve(tenantId, id, reviewer)
          : verb === "reject"
            ? await service.reject(tenantId, id, reviewer, str(body, "reason"))
            : await service.correct(tenantId, id, reviewer, {
                ...(typeof body["category"] === "string" && { category: body["category"] }),
                ...(typeof body["entityCode"] === "string" && { entityCode: body["entityCode"] }),
                ...(typeof body["note"] === "string" && { note: body["note"] }),
              });
      sendJson(res, 200, { item });
      return;
    }
    if (method === "GET" && path === "/metrics") {
      sendJson(res, 200, await service.metrics(tenantParam(url)));
      return;
    }
    if (method === "GET" && path === "/health") {
      const idle = url.searchParams.get("idleAfterDays");
      const report = await service.health(tenantParam(url), {
        idleAfterDays: idle ? Number(idle) : (options.idleAfterDays ?? 10),
      });
      // 200 for ok and idle: idle is a message for the sender, not an outage.
      sendJson(res, report.status === "broken" ? 503 : 200, report);
      return;
    }
    sendJson(res, 404, { error: "not_found", message: `${method} ${path}` });
  }
}

function tenantParam(url: URL): string {
  const tenant = url.searchParams.get("tenant");
  if (!tenant) throw new ReviewError("bad_request", "query parameter tenant is required");
  return tenant;
}

function str(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") throw new ReviewError("bad_request", `${field} is required`);
  return value;
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new ReviewError("bad_request", `body larger than ${maxBytes} bytes`);
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ReviewError("bad_request", "body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    throw new ReviewError("bad_request", "body is not valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
