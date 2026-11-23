import { calendarDateSchema, goalsWriteSchema, uuidSchema } from "../../src/lib/contracts/decimal";
import type { WorkerApp } from "../index";
import { apiError, apiValidationError } from "../transport";
import { authenticatedClient, readAccessCookie } from "./products";
// Date equality belongs to the SQL transaction, after receipt replay; calendar syntax belongs here.
const commandSchema = goalsWriteSchema.extend({ expected_date: calendarDateSchema });
export function registerGoalWriteRoutes(app: WorkerApp): void {
  app.put("/api/v1/goals/today", async (c) => {
    const match = c.req.header("If-Match");
    if (!match)
      return apiError(
        c,
        428,
        "PRECONDITION_REQUIRED",
        "Podaj dzisiejszą rewizję celów w If-Match.",
      );
    const parsedMatch = /^"(0|[1-9][0-9]*)"$/.exec(match);
    const revision = Number(parsedMatch?.[1]);
    if (!parsedMatch || !Number.isSafeInteger(revision) || revision > 2_147_483_647)
      return apiError(
        c,
        400,
        "BAD_REQUEST",
        "Nagłówek If-Match musi zawierać dzisiejszą rewizję celów.",
      );
    const key = c.req.header("Idempotency-Key");
    if (!uuidSchema.safeParse(key).success)
      return apiValidationError(c, "Idempotency-Key", "Podaj prawidłowy identyfikator UUID.");
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return apiError(c, 400, "BAD_REQUEST", "Treść żądania nie jest poprawnym JSON.");
    }
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success)
      return apiValidationError(
        c,
        String(parsed.error.issues[0]?.path[0] ?? "goals"),
        "Wpisz cztery dodatnie cele i poprawną datę.",
      );
    const token = readAccessCookie(c.req.raw);
    if (!token) return apiError(c, 401, "SESSION_REQUIRED", "Sesja wygasła. Zaloguj się ponownie.");
    try {
      const auth = await authenticatedClient(c, token);
      if (auth.kind === "unauthorized")
        return apiError(c, 401, "SESSION_REQUIRED", "Sesja wygasła. Zaloguj się ponownie.");
      if (auth.kind === "unavailable")
        return apiError(c, 503, "SERVICE_UNAVAILABLE", "Cele są chwilowo niedostępne.");
      const { data, error } = await auth.client.schema("api").rpc("save_today_goals", {
        p_payload: parsed.data,
        p_expected_revision: revision,
        p_idempotency_key: key,
      });
      if (!error) return c.json(data, 200);
      if (error.code === "22023")
        return apiValidationError(c, "goals", "Wpisz cztery dodatnie cele i poprawną datę.");
      if (error.code === "42501") return apiError(c, 403, "FORBIDDEN", "Brak dostępu do celów.");
      if (error.code === "P0001" && error.message === "DAY_CHANGED")
        return apiError(
          c,
          409,
          "DAY_CHANGED",
          "Rozpoczął się nowy dzień. Wczytaj dzisiejsze cele i potwierdź wartości.",
        );
      if (error.code === "P0001" && error.message === "REVISION_CONFLICT")
        return apiError(
          c,
          409,
          "REVISION_CONFLICT",
          "Dzisiejsze cele zmieniły się. Wczytaj aktualną wersję.",
        );
      if (error.code === "P0001" || error.code === "23505")
        return apiError(
          c,
          409,
          "CONFLICT",
          "Cele lub klucz zapisu kolidują z istniejącymi danymi.",
        );
    } catch {
      /* Private inputs and provider details stay out of responses/logs. */
    }
    return apiError(c, 503, "SERVICE_UNAVAILABLE", "Nie udało się potwierdzić zapisu celów.");
  });
}
