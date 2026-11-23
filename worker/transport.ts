import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { WorkerEnv } from "./types";

const MAX_JSON_BODY_BYTES = 256 * 1024;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ALLOWED_PREFLIGHT_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ALLOWED_PREFLIGHT_HEADERS = new Set([
  "content-type",
  "idempotency-key",
  "if-match",
  "x-requested-with",
]);

type ApiErrorCode =
  | "BAD_REQUEST"
  | "CONFLICT"
  | "IDEMPOTENCY_MISMATCH"
  | "REVISION_EXHAUSTED"
  | "FORBIDDEN"
  | "INTERNAL_ERROR"
  | "NOT_FOUND"
  | "PAYLOAD_TOO_LARGE"
  | "PRECONDITION_REQUIRED"
  | "PRODUCT_ARCHIVED"
  | "TEMPLATE_ARCHIVED"
  | "TEMPLATE_CHANGED"
  | "RESOURCE_DELETED"
  | "DAY_CHANGED"
  | "RATE_LIMIT"
  | "REVISION_CONFLICT"
  | "SESSION_REQUIRED"
  | "SERVICE_UNAVAILABLE"
  | "UNSUPPORTED_IMAGE"
  | "AI_LIMIT"
  | "AI_UNAVAILABLE"
  | "AI_INVALID_RESPONSE"
  | "AI_TIMEOUT";

function mergeVary(current: string | null, additions: string[]): string {
  const values = new Map<string, string>();
  for (const value of [...(current?.split(",") ?? []), ...additions]) {
    const trimmed = value.trim();
    if (trimmed) values.set(trimmed.toLowerCase(), trimmed);
  }
  return [...values.values()].join(", ");
}

function privateHeaders(c: Context<WorkerEnv>): void {
  c.header("Cache-Control", "no-store");
  c.header("Vary", mergeVary(c.res.headers.get("Vary"), ["Cookie"]));
  c.header("X-Request-ID", c.get("requestId"));
}

export function apiError(
  c: Context<WorkerEnv>,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 428 | 429 | 500 | 503 | 504,
  code: ApiErrorCode,
  message: string,
): Response {
  privateHeaders(c);
  return c.json({ code, message, request_id: c.get("requestId") }, status);
}

export function apiValidationError(
  c: Context<WorkerEnv>,
  field: string,
  message: string,
): Response {
  privateHeaders(c);
  return c.json(
    {
      code: "VALIDATION_ERROR",
      message: "Sprawdź poprawność danych.",
      field_errors: { [field]: message },
      request_id: c.get("requestId"),
    },
    422,
  );
}

function configuredOrigin(configured: string | undefined): string | null {
  if (!configured) return null;
  try {
    const parsed = new URL(configured);
    return parsed.protocol === "https:" && parsed.origin === configured ? parsed.origin : null;
  } catch {
    return null;
  }
}

function hasAllowedMutationOrigin(c: Context<WorkerEnv>, expectedOrigin: string): boolean {
  const requestOrigin = c.req.header("Origin");
  if (requestOrigin === expectedOrigin) return true;
  if (c.env.DEV_ORIGIN_FORWARDING !== "true" || c.req.header("X-Dev-Verified-HTTPS") !== "1")
    return false;

  const localProxyOrigin = `http://${new URL(expectedOrigin).host}`;
  return requestOrigin === localProxyOrigin;
}

async function validateJsonBody(request: Request): Promise<"too-large" | "invalid-json" | null> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" || !request.body) return null;

  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) return "too-large";

  const reader = request.clone().body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value) continue;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        // Cancel both tee branches; awaiting only the clone waits for the unread original.
        void reader.cancel().catch(() => {});
        void request.body?.cancel().catch(() => {});
        return "too-large";
      }
      chunks.push(chunk.value);
    }
  } catch {
    return "invalid-json";
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    return null;
  } catch {
    return "invalid-json";
  }
}

function isAllowedPreflight(c: Context<WorkerEnv>, origin: string): boolean {
  const requestedMethod = c.req.header("Access-Control-Request-Method")?.toUpperCase();
  const requestedHeaders = (c.req.header("Access-Control-Request-Headers") ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  return (
    origin === c.req.header("Origin") &&
    Boolean(requestedMethod && ALLOWED_PREFLIGHT_METHODS.has(requestedMethod)) &&
    requestedHeaders.every((header) => ALLOWED_PREFLIGHT_HEADERS.has(header))
  );
}

export const apiTransport = createMiddleware<WorkerEnv>(async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  const origin = configuredOrigin(c.env.APP_ORIGIN);
  if (!origin) {
    return apiError(c, 503, "SERVICE_UNAVAILABLE", "Transport API nie jest skonfigurowany.");
  }

  if (c.req.method === "OPTIONS") {
    if (!isAllowedPreflight(c, origin)) {
      return apiError(c, 403, "FORBIDDEN", "Żądanie nie pochodzi z dozwolonego originu.");
    }
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    c.header("Access-Control-Allow-Headers", [...ALLOWED_PREFLIGHT_HEADERS].join(", "));
    c.header("Vary", mergeVary(c.res.headers.get("Vary"), ["Origin"]));
    privateHeaders(c);
    return c.body(null, 204);
  }

  if (MUTATING_METHODS.has(c.req.method)) {
    if (!hasAllowedMutationOrigin(c, origin)) {
      void c.req.raw.body?.cancel().catch(() => {});
      return apiError(c, 403, "FORBIDDEN", "Żądanie nie pochodzi z dozwolonego originu.");
    }
    if (c.req.header("X-Requested-With") !== "DziennikJedzenia") {
      void c.req.raw.body?.cancel().catch(() => {});
      return apiError(c, 403, "FORBIDDEN", "Brakuje wymaganego nagłówka żądania.");
    }
  }

  const bodyProblem =
    c.req.path === "/api/v1/label-readings" ? null : await validateJsonBody(c.req.raw);
  if (bodyProblem === "too-large") {
    return apiError(c, 413, "PAYLOAD_TOO_LARGE", "Treść żądania przekracza limit 256 KiB.");
  }
  if (bodyProblem === "invalid-json") {
    return apiError(c, 400, "BAD_REQUEST", "Treść żądania nie jest poprawnym JSON.");
  }

  await next();
  privateHeaders(c);
  return;
});
