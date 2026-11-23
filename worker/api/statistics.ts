import type { Context } from "hono";
import {
  statisticsDateSchema,
  statisticsRangeSchema,
  statisticsSchema,
  weightMutationSchema,
  weightWriteSchema,
} from "../../src/lib/contracts/statistics";
import { uuidSchema } from "../../src/lib/contracts/decimal";
import type { WorkerApp } from "../index";
import type { WorkerEnv } from "../types";
import { apiError, apiValidationError } from "../transport";
import { authenticatedClient, readAccessCookie } from "./products";

type Operation = "get_statistics" | "save_weight_entry" | "delete_weight_entry";
function rpcError(
  c: Context<WorkerEnv>,
  error: { code?: string; message?: string },
  field: string,
): Response {
  if (["22023", "22007", "22008"].includes(error.code ?? ""))
    return apiValidationError(c, field, "Sprawdź daty i wartość pomiaru.");
  if (error.code === "42501") return apiError(c, 403, "FORBIDDEN", "Brak dostępu do statystyk.");
  if (error.code === "P0002") return apiError(c, 404, "NOT_FOUND", "Pomiar nie istnieje.");
  if (error.code === "P0001") {
    switch (error.message) {
      case "REVISION_CONFLICT":
        return apiError(c, 409, "REVISION_CONFLICT", "Pomiar zmienił się. Wczytaj aktualne dane.");
      case "IDEMPOTENCY_MISMATCH":
        return apiError(
          c,
          409,
          "IDEMPOTENCY_MISMATCH",
          "Klucz zapisu został już użyty dla innego żądania.",
        );
      case "REVISION_EXHAUSTED":
        return apiError(c, 409, "REVISION_EXHAUSTED", "Nie można już zmienić tego pomiaru.");
    }
  }
  if (error.code === "23505")
    return apiError(c, 409, "CONFLICT", "Pomiar koliduje z istniejącymi danymi.");
  return apiError(c, 503, "SERVICE_UNAVAILABLE", "Statystyki są chwilowo niedostępne.");
}
async function rpc(
  c: Context<WorkerEnv>,
  operation: Operation,
  args: Record<string, unknown>,
): Promise<Response> {
  const token = readAccessCookie(c.req.raw);
  if (!token) return apiError(c, 401, "SESSION_REQUIRED", "Sesja wygasła. Zaloguj się ponownie.");
  try {
    const auth = await authenticatedClient(c, token);
    if (auth.kind === "unauthorized")
      return apiError(c, 401, "SESSION_REQUIRED", "Sesja wygasła. Zaloguj się ponownie.");
    if (auth.kind === "unavailable")
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Statystyki są chwilowo niedostępne.");
    const { data, error } = await auth.client.schema("api").rpc(operation, args);
    if (error) return rpcError(c, error, operation === "get_statistics" ? "range" : "weight_kg");
    const parsed =
      operation === "get_statistics"
        ? statisticsSchema.safeParse(data)
        : weightMutationSchema.safeParse(data);
    if (parsed.success) return c.json(parsed.data, 200);
  } catch {
    /* Never expose upstream messages, inputs or authentication details. */
  }
  return apiError(c, 503, "SERVICE_UNAVAILABLE", "Nie udało się potwierdzić wyniku operacji.");
}
async function mutate(c: Context<WorkerEnv>, remove: boolean): Promise<Response> {
  const date = statisticsDateSchema.safeParse(c.req.param("date"));
  if (!date.success)
    return apiValidationError(c, "date", "Wybierz istniejącą datę od 01.01.1900 do dzisiaj.");
  const value = c.req.header("If-Match");
  if (!value)
    return apiError(c, 428, "PRECONDITION_REQUIRED", "Podaj aktualną rewizję pomiaru w If-Match.");
  const match = /^"(0|[1-9][0-9]*)"$/.exec(value);
  const revision = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(revision) || revision > 2_147_483_647)
    return apiError(c, 400, "BAD_REQUEST", "Nagłówek If-Match musi zawierać prawidłową rewizję.");
  const key = uuidSchema.safeParse(c.req.header("Idempotency-Key"));
  if (!key.success)
    return apiValidationError(c, "Idempotency-Key", "Podaj prawidłowy identyfikator UUID.");
  const args: Record<string, unknown> = {
    p_date: date.data,
    p_expected_revision: revision,
    p_idempotency_key: key.data,
  };
  if (remove) {
    // A real HTTP DELETE can expose a stream with zero bytes. Reject content,
    // rather than the stream object, without trusting Content-Length or buffering it.
    const reader = c.req.raw.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.byteLength) {
            void reader.cancel().catch(() => {});
            return apiError(
              c,
              400,
              "BAD_REQUEST",
              "Usunięcie pomiaru nie przyjmuje treści żądania.",
            );
          }
        }
      } catch {
        return apiError(c, 400, "BAD_REQUEST", "Nie udało się odczytać żądania usunięcia pomiaru.");
      }
    }
  } else {
    if (c.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
      return apiError(c, 400, "BAD_REQUEST", "Wyślij dane jako application/json.");
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return apiError(c, 400, "BAD_REQUEST", "Treść żądania nie jest poprawnym JSON.");
    }
    const payload = weightWriteSchema.safeParse(input);
    if (!payload.success)
      return apiValidationError(
        c,
        "weight_kg",
        "Wpisz wagę od 0.01 do 999.99 kg z maksymalnie dwoma miejscami po przecinku.",
      );
    args["p_payload"] = payload.data;
  }
  return rpc(c, remove ? "delete_weight_entry" : "save_weight_entry", args);
}
export function registerStatisticsRoutes(app: WorkerApp): void {
  app.get("/api/v1/statistics", async (c) => {
    const range = statisticsRangeSchema.safeParse({
      from: c.req.query("from"),
      to: c.req.query("to"),
    });
    if (!range.success)
      return apiValidationError(
        c,
        String(range.error.issues[0]?.path[0] ?? "range"),
        "Wybierz poprawny zakres od 1 do 366 dni, nie późniejszy niż dzisiaj.",
      );
    return rpc(c, "get_statistics", { p_from: range.data.from, p_to: range.data.to });
  });
  app.put("/api/v1/weight-entries/:date", (c) => mutate(c, false));
  app.delete("/api/v1/weight-entries/:date", (c) => mutate(c, true));
}
