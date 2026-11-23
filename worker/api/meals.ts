import type { Context } from "hono";
import { mealCreateSchema, mealUpdateSchema, uuidSchema } from "../../src/lib/contracts/decimal";
import type { WorkerApp } from "../index";
import type { WorkerEnv } from "../types";
import { apiError, apiValidationError } from "../transport";
import { authenticatedClient, readAccessCookie } from "./products";

export async function mealRpc(
  c: Context<WorkerEnv>,
  operation: string,
  parameters: Record<string, unknown>,
): Promise<{ data: unknown } | Response> {
  const token = readAccessCookie(c.req.raw);
  if (!token) return apiError(c, 401, "SESSION_REQUIRED", "Sesja wygasła. Zaloguj się ponownie.");
  try {
    const auth = await authenticatedClient(c, token);
    if (auth.kind === "unauthorized")
      return apiError(c, 401, "SESSION_REQUIRED", "Sesja wygasła. Zaloguj się ponownie.");
    if (auth.kind === "unavailable")
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Dziennik jest chwilowo niedostępny.");
    const { data, error } = await auth.client.schema("api").rpc(operation, parameters);
    if (!error) return { data };
    if (error.code === "22023")
      return apiValidationError(c, "items", "Sprawdź nazwę, datę i składniki posiłku.");
    if (error.code === "42501") return apiError(c, 403, "FORBIDDEN", "Brak dostępu do dziennika.");
    if (error.code === "P0001") {
      if (error.message === "RESOURCE_DELETED")
        return apiError(
          c,
          409,
          "RESOURCE_DELETED",
          "Ten posiłek został usunięty. Zapis nie został zastosowany.",
        );
      if (error.message === "PRODUCT_ARCHIVED")
        return apiError(c, 409, "PRODUCT_ARCHIVED", "Zastąp zarchiwizowany składnik.");
      if (error.message === "TEMPLATE_ARCHIVED")
        return apiError(
          c,
          409,
          "TEMPLATE_ARCHIVED",
          "Zestaw został zarchiwizowany. Wybierz inne źródło.",
        );
      if (error.message === "TEMPLATE_CHANGED")
        return apiError(c, 409, "TEMPLATE_CHANGED", "Zestaw zmienił się. Wczytaj go ponownie.");
      if (error.message === "REVISION_CONFLICT")
        return apiError(
          c,
          409,
          "REVISION_CONFLICT",
          "Posiłek lub produkt zmienił się. Wczytaj aktualne dane.",
        );
    }
    if (error.code === "P0001" || error.code === "23505")
      return apiError(
        c,
        409,
        "CONFLICT",
        "Posiłek lub klucz zapisu koliduje z istniejącymi danymi.",
      );
  } catch {
    /* No provider details or private contents in responses/logs. */
  }
  return apiError(c, 503, "SERVICE_UNAVAILABLE", "Dziennik jest chwilowo niedostępny.");
}

export function registerMealRoutes(app: WorkerApp): void {
  app.delete("/api/v1/diary-meals/:meal_id", async (c) => {
    const id = c.req.param("meal_id");
    if (!uuidSchema.safeParse(id).success)
      return apiError(c, 400, "BAD_REQUEST", "Podaj prawidłowy identyfikator UUID posiłku.");
    const match = c.req.header("If-Match");
    if (!match)
      return apiError(
        c,
        428,
        "PRECONDITION_REQUIRED",
        "Podaj aktualną rewizję posiłku w If-Match.",
      );
    const parsedMatch = /^"([1-9][0-9]*)"$/.exec(match);
    const revision = Number(parsedMatch?.[1]);
    if (!parsedMatch || !Number.isSafeInteger(revision) || revision > 2_147_483_647)
      return apiError(c, 400, "BAD_REQUEST", "Nagłówek If-Match musi zawierać rewizję posiłku.");
    const key = c.req.header("Idempotency-Key");
    if (!uuidSchema.safeParse(key).success)
      return apiValidationError(c, "Idempotency-Key", "Podaj prawidłowy identyfikator UUID.");
    const result = await mealRpc(c, "delete_meal", {
      p_meal_id: id,
      p_expected_revision: revision,
      p_idempotency_key: key,
    });
    if (result instanceof Response) return result;
    if (!result.data) return apiError(c, 404, "NOT_FOUND", "Nie znaleziono posiłku.");
    return c.json(result.data, 200);
  });
  app.put("/api/v1/diary-meals/:meal_id", async (c) => {
    const id = c.req.param("meal_id");
    if (!uuidSchema.safeParse(id).success)
      return apiError(c, 400, "BAD_REQUEST", "Podaj prawidłowy identyfikator UUID posiłku.");
    const match = c.req.header("If-Match");
    if (!match)
      return apiError(
        c,
        428,
        "PRECONDITION_REQUIRED",
        "Podaj aktualną rewizję posiłku w If-Match.",
      );
    const parsedMatch = /^"([1-9][0-9]*)"$/.exec(match);
    const revision = Number(parsedMatch?.[1]);
    if (!parsedMatch || !Number.isSafeInteger(revision) || revision > 2_147_483_647)
      return apiError(c, 400, "BAD_REQUEST", "Nagłówek If-Match musi zawierać rewizję posiłku.");
    const key = c.req.header("Idempotency-Key");
    if (!uuidSchema.safeParse(key).success)
      return apiValidationError(c, "Idempotency-Key", "Podaj prawidłowy identyfikator UUID.");
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return apiError(c, 400, "BAD_REQUEST", "Treść żądania nie jest poprawnym JSON.");
    }
    const parsed = mealUpdateSchema.safeParse(input);
    if (!parsed.success)
      return apiValidationError(
        c,
        String(parsed.error.issues[0]?.path[0] ?? "items"),
        "Sprawdź nazwę, datę i składniki posiłku.",
      );
    const result = await mealRpc(c, "update_meal", {
      p_meal_id: id,
      p_payload: parsed.data,
      p_expected_revision: revision,
      p_idempotency_key: key,
    });
    if (result instanceof Response) return result;
    if (!result.data) return apiError(c, 404, "NOT_FOUND", "Nie znaleziono posiłku.");
    return c.json(result.data, 200);
  });
  app.post("/api/v1/diary-meals", async (c) => {
    const key = c.req.header("Idempotency-Key");
    if (!uuidSchema.safeParse(key).success)
      return apiValidationError(c, "Idempotency-Key", "Podaj prawidłowy identyfikator UUID.");
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return apiError(c, 400, "BAD_REQUEST", "Treść żądania nie jest poprawnym JSON.");
    }
    const parsed = mealCreateSchema.safeParse(input);
    if (!parsed.success)
      return apiValidationError(
        c,
        String(parsed.error.issues[0]?.path[0] ?? "items"),
        "Sprawdź nazwę, datę i składniki posiłku.",
      );
    const result = await mealRpc(c, "create_meal", {
      p_payload: parsed.data,
      p_idempotency_key: key,
    });
    if (result instanceof Response) return result;
    if (!result.data || typeof result.data !== "object" || !("replayed" in result.data))
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Nie udało się potwierdzić zapisu posiłku.");
    return c.json(result.data, result.data.replayed === true ? 200 : 201);
  });
  app.get("/api/v1/diary-meals/:meal_id", async (c) => {
    const id = c.req.param("meal_id");
    if (!uuidSchema.safeParse(id).success)
      return apiError(c, 400, "BAD_REQUEST", "Podaj prawidłowy identyfikator UUID posiłku.");
    const result = await mealRpc(c, "get_meal", { p_meal_id: id });
    if (result instanceof Response) return result;
    if (!result.data) return apiError(c, 404, "NOT_FOUND", "Nie znaleziono posiłku.");
    const revision = (result.data as { revision?: unknown }).revision;
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1)
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Nie udało się odczytać posiłku.");
    c.header("ETag", `"${revision}"`);
    return c.json(result.data, 200);
  });
}
