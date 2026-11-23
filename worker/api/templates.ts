import type { Context } from "hono";
import {
  templateCreateSchema,
  templateUpdateSchema,
  uuidSchema,
} from "../../src/lib/contracts/decimal";
import type { WorkerApp } from "../index";
import type { WorkerEnv } from "../types";
import { apiError, apiValidationError } from "../transport";
import { authenticatedClient, readAccessCookie } from "./products";

async function templateRpc(
  c: Context<WorkerEnv>,
  operation: string,
  parameters: Record<string, unknown>,
): Promise<{ data: unknown } | Response> {
  const token = readAccessCookie(c.req.raw);
  if (!token) return apiError(c, 401, "SESSION_REQUIRED", "Sesja wygasła. Zaloguj się ponownie.");
  try {
    const authenticated = await authenticatedClient(c, token);
    if (authenticated.kind === "unauthorized")
      return apiError(c, 401, "SESSION_REQUIRED", "Sesja wygasła. Zaloguj się ponownie.");
    if (authenticated.kind === "unavailable")
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Zestawy są chwilowo niedostępne.");
    const { data, error } = await authenticated.client.schema("api").rpc(operation, parameters);
    if (!error) return { data };
    if (error.code === "22023")
      return apiValidationError(c, "items", "Sprawdź nazwę, produkty i ilości składników.");
    if (error.code === "42501") return apiError(c, 403, "FORBIDDEN", "Brak dostępu do zestawów.");
    if (error.code === "P0001" && error.message === "PRODUCT_ARCHIVED")
      return apiError(c, 409, "PRODUCT_ARCHIVED", "Wymień zarchiwizowany składnik zestawu.");
    if (error.code === "P0001" && error.message === "TEMPLATE_ARCHIVED")
      return apiError(c, 409, "TEMPLATE_ARCHIVED", "Ten zestaw został zarchiwizowany.");
    if (error.code === "P0001" && error.message === "REVISION_CONFLICT")
      return apiError(
        c,
        409,
        "REVISION_CONFLICT",
        "Zestaw lub produkt zmienił się. Wczytaj składniki ponownie.",
      );
    if (error.code === "P0001" || error.code === "23505")
      return apiError(
        c,
        409,
        "CONFLICT",
        "Zestaw lub klucz zapisu koliduje z istniejącymi danymi.",
      );
  } catch {
    // Provider details and private request contents stay out of responses and logs.
  }
  return apiError(c, 503, "SERVICE_UNAVAILABLE", "Zestawy są chwilowo niedostępne.");
}

export function registerTemplateRoutes(app: WorkerApp): void {
  async function mutateTemplate(c: Context<WorkerEnv>, archive: boolean): Promise<Response> {
    const id = c.req.param("template_id");
    if (!uuidSchema.safeParse(id).success)
      return apiError(c, 400, "BAD_REQUEST", "Podaj prawidłowy identyfikator UUID zestawu.");
    const ifMatch = c.req.header("If-Match");
    if (!ifMatch)
      return apiError(
        c,
        428,
        "PRECONDITION_REQUIRED",
        "Podaj aktualną rewizję zestawu w If-Match.",
      );
    const match = /^"([1-9][0-9]*)"$/.exec(ifMatch);
    const revision = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(revision) || revision > 2_147_483_647)
      return apiError(c, 400, "BAD_REQUEST", "Nagłówek If-Match musi zawierać rewizję zestawu.");
    const key = c.req.header("Idempotency-Key");
    if (!uuidSchema.safeParse(key).success)
      return apiValidationError(c, "Idempotency-Key", "Podaj prawidłowy identyfikator UUID.");
    const parameters: Record<string, unknown> = {
      p_template_id: id,
      p_expected_revision: revision,
      p_idempotency_key: key,
    };
    if (!archive) {
      let input: unknown;
      try {
        input = await c.req.json();
      } catch {
        return apiError(c, 400, "BAD_REQUEST", "Treść żądania nie jest poprawnym JSON.");
      }
      const parsed = templateUpdateSchema.safeParse(input);
      if (!parsed.success)
        return apiValidationError(
          c,
          String(parsed.error.issues[0]?.path[0] ?? "items"),
          "Sprawdź nazwę i składniki zestawu.",
        );
      parameters["p_payload"] = parsed.data;
    }
    const result = await templateRpc(
      c,
      archive ? "archive_template" : "update_template",
      parameters,
    );
    if (result instanceof Response) return result;
    if (!result.data) return apiError(c, 404, "NOT_FOUND", "Nie znaleziono zestawu.");
    return c.json(result.data, 200);
  }

  app.put("/api/v1/meal-templates/:template_id", (c) => mutateTemplate(c, false));
  app.delete("/api/v1/meal-templates/:template_id", (c) => mutateTemplate(c, true));

  app.post("/api/v1/meal-templates", async (c) => {
    const key = c.req.header("Idempotency-Key");
    if (!uuidSchema.safeParse(key).success)
      return apiValidationError(c, "Idempotency-Key", "Podaj prawidłowy identyfikator UUID.");
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return apiError(c, 400, "BAD_REQUEST", "Treść żądania nie jest poprawnym JSON.");
    }
    const parsed = templateCreateSchema.safeParse(input);
    if (!parsed.success)
      return apiValidationError(
        c,
        String(parsed.error.issues[0]?.path[0] ?? "items"),
        "Sprawdź nazwę i składniki zestawu.",
      );
    const result = await templateRpc(c, "create_template", {
      p_payload: parsed.data,
      p_idempotency_key: key,
    });
    if (result instanceof Response) return result;
    if (!result.data || typeof result.data !== "object" || !("replayed" in result.data))
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Nie udało się potwierdzić zapisu zestawu.");
    return c.json(result.data, result.data.replayed === true ? 200 : 201);
  });

  app.get("/api/v1/meal-templates", async (c) => {
    const q = c.req.query("q") ?? "";
    const archived = c.req.query("include_archived") ?? "false";
    const limit = c.req.query("limit") ?? "50";
    const offset = c.req.query("offset") ?? "0";
    if (
      q.length > 160 ||
      !["true", "false"].includes(archived) ||
      !/^\d+$/.test(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 100 ||
      !/^\d+$/.test(offset) ||
      Number(offset) > 2_147_483_647
    )
      return apiError(c, 400, "BAD_REQUEST", "Sprawdź zapytanie, limit (1–100) i przesunięcie.");
    const result = await templateRpc(c, "list_templates", {
      p_q: q,
      p_include_archived: archived === "true",
      p_limit: Number(limit),
      p_offset: Number(offset),
    });
    if (result instanceof Response) return result;
    return c.json(result.data, 200);
  });

  app.get("/api/v1/meal-templates/:template_id", async (c) => {
    const id = c.req.param("template_id");
    if (!uuidSchema.safeParse(id).success)
      return apiError(c, 400, "BAD_REQUEST", "Podaj prawidłowy identyfikator UUID zestawu.");
    const result = await templateRpc(c, "get_template", { p_template_id: id });
    if (result instanceof Response) return result;
    if (!result.data) return apiError(c, 404, "NOT_FOUND", "Nie znaleziono zestawu.");
    const revision = (result.data as { revision?: unknown }).revision;
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1)
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Nie udało się odczytać zestawu.");
    c.header("ETag", `"${revision}"`);
    return c.json(result.data, 200);
  });
}
