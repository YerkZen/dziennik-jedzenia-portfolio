import { safeUpstreamFetch } from "../upstream-fetch";
import { createClient } from "@supabase/supabase-js";
import type { Context } from "hono";
import {
  productCreateSchema,
  productUpdateSchema,
  uuidSchema,
} from "../../src/lib/contracts/decimal";
import { apiError, apiValidationError } from "../transport";
import type { WorkerApp } from "../index";
import type { WorkerEnv } from "../types";

const ACCESS_COOKIE = "__Host-dd-access";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readAccessCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== ACCESS_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function isServiceRoleKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  const segment = key.split(".")[1];
  if (!segment) return false;
  try {
    const payload = JSON.parse(atob(segment.replaceAll("-", "+").replaceAll("_", "/"))) as {
      role?: string;
    };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

export async function authenticatedClient(c: Context<WorkerEnv>, token: string) {
  const cached = c.get("authenticatedSupabase");
  if (cached?.token === token) return { kind: "client" as const, client: cached.client };
  const url = c.env.SUPABASE_URL;
  const key = c.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || isServiceRoleKey(key)) return { kind: "unavailable" as const };
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { fetch: safeUpstreamFetch, headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    return error?.status && error.status >= 500
      ? { kind: "unavailable" as const }
      : { kind: "unauthorized" as const };
  }
  c.set("authenticatedSupabase", { token, client });
  return { kind: "client" as const, client };
}

function sessionRequired(c: Context<WorkerEnv>) {
  return apiError(c, 401, "SESSION_REQUIRED", "Sesja wygasła. Zaloguj się ponownie.");
}

function mapRpcError(
  c: Context<WorkerEnv>,
  error: { code?: string; message?: string },
  validationField = "product",
): Response {
  if (error.code === "22023")
    return apiValidationError(c, validationField, "Dane produktu lub zapytanie są niepoprawne.");
  if (error.code === "42501") return apiError(c, 403, "FORBIDDEN", "Brak dostępu do produktu.");
  if (error.code === "P0001" && error.message === "REVISION_CONFLICT")
    return apiError(c, 409, "REVISION_CONFLICT", "Produkt zmienił się od czasu jego wczytania.");
  if (error.code === "P0001" && error.message === "PRODUCT_ARCHIVED")
    return apiError(c, 409, "PRODUCT_ARCHIVED", "Zarchiwizowanego produktu nie można zmienić.");
  if (error.code === "P0001" || error.code === "23505")
    return apiError(c, 409, "CONFLICT", "Produkt lub klucz zapisu koliduje z istniejącymi danymi.");
  return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa produktów jest chwilowo niedostępna.");
}

function parseIfMatch(c: Context<WorkerEnv>): number | Response {
  const value = c.req.header("If-Match");
  if (!value)
    return apiError(c, 428, "PRECONDITION_REQUIRED", "Podaj aktualną rewizję produktu w If-Match.");
  const match = /^"([1-9][0-9]*)"$/.exec(value);
  const revision = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(revision) || revision > 2_147_483_647)
    return apiError(c, 400, "BAD_REQUEST", "Nagłówek If-Match musi zawierać rewizję produktu.");
  return revision;
}

async function getList(c: Context<WorkerEnv>): Promise<Response> {
  const q = c.req.query("q") ?? "";
  const archivedParam = c.req.query("include_archived") ?? "false";
  const limitParam = c.req.query("limit") ?? "50";
  const offsetParam = c.req.query("offset") ?? "0";
  if (q.length > 160) return apiValidationError(c, "q", "Wpisz maksymalnie 160 znaków.");
  if (archivedParam !== "true" && archivedParam !== "false")
    return apiValidationError(c, "include_archived", "Wybierz true albo false.");
  if (!/^\d+$/.test(limitParam) || Number(limitParam) < 1 || Number(limitParam) > 100)
    return apiValidationError(c, "limit", "Limit musi wynosić od 1 do 100.");
  if (!/^\d+$/.test(offsetParam) || Number(offsetParam) > 2_147_483_647)
    return apiValidationError(c, "offset", "Przesunięcie musi być nieujemną liczbą całkowitą.");

  const token = readAccessCookie(c.req.raw);
  if (!token) return sessionRequired(c);
  try {
    const authenticated = await authenticatedClient(c, token);
    if (authenticated.kind === "unauthorized") return sessionRequired(c);
    if (authenticated.kind === "unavailable")
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa produktów jest chwilowo niedostępna.");
    const { data, error } = await authenticated.client.schema("api").rpc("list_products", {
      p_q: q,
      p_include_archived: archivedParam === "true",
      p_limit: Number(limitParam),
      p_offset: Number(offsetParam),
    });
    if (error) return mapRpcError(c, error, "q");
    if (!data) return apiError(c, 403, "FORBIDDEN", "To konto nie ma dostępu do produktów.");
    return c.json(data, 200);
  } catch {
    return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa produktów jest chwilowo niedostępna.");
  }
}

async function createProduct(c: Context<WorkerEnv>): Promise<Response> {
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!uuidSchema.safeParse(idempotencyKey).success)
    return apiValidationError(c, "Idempotency-Key", "Podaj prawidłowy identyfikator UUID.");

  let input: unknown;
  try {
    input = await c.req.json();
  } catch {
    return apiError(c, 400, "BAD_REQUEST", "Treść żądania nie jest poprawnym JSON.");
  }
  const parsed = productCreateSchema.safeParse(input);
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "product");
    return apiValidationError(
      c,
      field,
      parsed.error.issues[0]?.message ?? "Dane produktu są niepoprawne.",
    );
  }

  const token = readAccessCookie(c.req.raw);
  if (!token) return sessionRequired(c);
  try {
    const authenticated = await authenticatedClient(c, token);
    if (authenticated.kind === "unauthorized") return sessionRequired(c);
    if (authenticated.kind === "unavailable")
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa produktów jest chwilowo niedostępna.");
    const { data, error } = await authenticated.client.schema("api").rpc("create_product", {
      p_payload: parsed.data,
      p_idempotency_key: idempotencyKey,
    });
    if (error) return mapRpcError(c, error);
    if (!data || typeof data !== "object" || !("replayed" in data))
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa produktów jest chwilowo niedostępna.");
    const replayed = (data as { replayed: unknown }).replayed;
    return c.json(data, replayed === true ? 200 : 201);
  } catch {
    return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa produktów jest chwilowo niedostępna.");
  }
}

async function getProduct(c: Context<WorkerEnv>): Promise<Response> {
  const productId = c.req.param("product_id") ?? "";
  if (!UUID_PATTERN.test(productId))
    return apiValidationError(c, "product_id", "Podaj prawidłowy identyfikator UUID.");
  const token = readAccessCookie(c.req.raw);
  if (!token) return sessionRequired(c);
  try {
    const authenticated = await authenticatedClient(c, token);
    if (authenticated.kind === "unauthorized") return sessionRequired(c);
    if (authenticated.kind === "unavailable")
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa produktów jest chwilowo niedostępna.");
    const { data, error } = await authenticated.client.schema("api").rpc("get_product", {
      p_product_id: productId,
    });
    if (error) return mapRpcError(c, error, "product_id");
    if (!data) return apiError(c, 404, "NOT_FOUND", "Nie znaleziono produktu.");
    const revision = (data as { revision?: unknown }).revision;
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1)
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa produktów jest chwilowo niedostępna.");
    c.header("ETag", `"${revision}"`);
    return c.json(data, 200);
  } catch {
    return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa produktów jest chwilowo niedostępna.");
  }
}

async function updateProduct(c: Context<WorkerEnv>): Promise<Response> {
  const productId = c.req.param("product_id") ?? "";
  if (!UUID_PATTERN.test(productId))
    return apiValidationError(c, "product_id", "Podaj prawidłowy identyfikator UUID.");
  const expectedRevision = parseIfMatch(c);
  if (expectedRevision instanceof Response) return expectedRevision;
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!uuidSchema.safeParse(idempotencyKey).success)
    return apiValidationError(c, "Idempotency-Key", "Podaj prawidłowy identyfikator UUID.");

  let input: unknown;
  try {
    input = await c.req.json();
  } catch {
    return apiError(c, 400, "BAD_REQUEST", "Treść żądania nie jest poprawnym JSON.");
  }
  const parsed = productUpdateSchema.safeParse(input);
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "product");
    return apiValidationError(
      c,
      field,
      parsed.error.issues[0]?.message ?? "Dane produktu są niepoprawne.",
    );
  }

  const token = readAccessCookie(c.req.raw);
  if (!token) return sessionRequired(c);
  try {
    const authenticated = await authenticatedClient(c, token);
    if (authenticated.kind === "unauthorized") return sessionRequired(c);
    if (authenticated.kind === "unavailable")
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa produktów jest chwilowo niedostępna.");
    const { data, error } = await authenticated.client.schema("api").rpc("update_product", {
      p_product_id: productId,
      p_payload: parsed.data,
      p_expected_revision: expectedRevision,
      p_idempotency_key: idempotencyKey,
    });
    if (error) return mapRpcError(c, error, "product_id");
    if (!data) return apiError(c, 404, "NOT_FOUND", "Nie znaleziono produktu.");
    return c.json(data, 200);
  } catch {
    return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa produktów jest chwilowo niedostępna.");
  }
}

async function archiveProduct(c: Context<WorkerEnv>): Promise<Response> {
  const productId = c.req.param("product_id") ?? "";
  if (!UUID_PATTERN.test(productId))
    return apiValidationError(c, "product_id", "Podaj prawidłowy identyfikator UUID.");
  const expectedRevision = parseIfMatch(c);
  if (expectedRevision instanceof Response) return expectedRevision;
  const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
  if (!uuidSchema.safeParse(idempotencyKey).success)
    return apiValidationError(c, "Idempotency-Key", "Podaj prawidłowy identyfikator UUID.");

  const token = readAccessCookie(c.req.raw);
  if (!token) return sessionRequired(c);
  try {
    const authenticated = await authenticatedClient(c, token);
    if (authenticated.kind === "unauthorized") return sessionRequired(c);
    if (authenticated.kind === "unavailable")
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa produktów jest chwilowo niedostępna.");
    const { data, error } = await authenticated.client.schema("api").rpc("archive_product", {
      p_product_id: productId,
      p_expected_revision: expectedRevision,
      p_idempotency_key: idempotencyKey,
    });
    if (error) return mapRpcError(c, error, "product_id");
    if (!data) return apiError(c, 404, "NOT_FOUND", "Nie znaleziono produktu.");
    return c.json(data, 200);
  } catch {
    return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa produktów jest chwilowo niedostępna.");
  }
}

export function registerProductRoutes(app: WorkerApp): void {
  app.get("/api/v1/products", getList);
  app.post("/api/v1/products", createProduct);
  app.get("/api/v1/products/:product_id", getProduct);
  app.put("/api/v1/products/:product_id", updateProduct);
  app.delete("/api/v1/products/:product_id", archiveProduct);
}
