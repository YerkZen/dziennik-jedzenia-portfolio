import { z } from "zod";
import { apiRequest, ApiRequestError } from "./client";
import {
  statisticsDateSchema,
  statisticsSchema,
  weightMutationSchema,
  type StatisticsDay,
  type StatisticsRange,
} from "../contracts/statistics";
import type { MutationAck } from "./products";

export type WeightCommand = {
  date: string;
  revision: number;
} & ({ kind: "save"; weight: string } | { kind: "delete" });

export async function mutateWeight(command: WeightCommand, key: string): Promise<MutationAck> {
  const raw = await apiRequest<unknown>(`/api/v1/weight-entries/${command.date}`, {
    method: command.kind === "save" ? "PUT" : "DELETE",
    headers: { "If-Match": `"${command.revision}"`, "Idempotency-Key": key },
    ...(command.kind === "save" ? { body: JSON.stringify({ weight_kg: command.weight }) } : {}),
  });
  const result = weightMutationSchema.safeParse(raw);
  if (!result.success || result.data.date !== command.date)
    throw new ApiRequestError("Nie udało się potwierdzić zapisu. Ponów.", 0, "INVALID_ACK");
  return { ...result.data, resource_id: result.data.date };
}

export const statisticsSelectionSchema = z
  .object({ from: statisticsDateSchema, to: statisticsDateSchema })
  .strict()
  .refine((range) => range.from <= range.to, {
    path: ["to"],
    message: "Data Do nie może poprzedzać daty Od.",
  });
export function shiftStatisticsDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function defaultStatisticsRange(today: string): StatisticsRange {
  return { from: shiftStatisticsDate(today, -29), to: today };
}
export function statisticsDateLabel(date: string): string {
  return date.split("-").reverse().join(".");
}
export interface StatisticsSeries {
  from: string;
  to: string;
  today: string;
  timezone: "Europe/Warsaw";
  days: StatisticsDay[];
}
export interface StatisticsProgress {
  completed: number;
  total: number;
}
export async function getStatistics(
  range: StatisticsRange,
  options: { signal?: AbortSignal; onProgress?: (progress: StatisticsProgress) => void } = {},
): Promise<StatisticsSeries> {
  const selection = statisticsSelectionSchema.safeParse(range);
  if (!selection.success)
    throw new ApiRequestError("Wybierz poprawny zakres dat.", 422, "VALIDATION_ERROR");
  const total = Math.ceil(((Date.parse(range.to) - Date.parse(range.from)) / 86400000 + 1) / 366);
  const days: StatisticsDay[] = [];
  let completed = 0;
  let today = "";
  options.onProgress?.({ completed, total });
  for (let from = range.from; from <= range.to;) {
    options.signal?.throwIfAborted();
    const to = [shiftStatisticsDate(from, 365), range.to].sort()[0]!;
    let raw: unknown;
    try {
      raw = await apiRequest<unknown>(`/api/v1/statistics?from=${from}&to=${to}`, {
        signal: options.signal ?? null,
      });
    } catch (error) {
      options.signal?.throwIfAborted();
      throw error;
    }
    options.signal?.throwIfAborted();
    const parsed = statisticsSchema.safeParse(raw);
    if (!parsed.success || parsed.data.from !== from || parsed.data.to !== to)
      throw new ApiRequestError(
        "Otrzymano niepełne dane statystyk. Ponów odczyt.",
        503,
        "INVALID_RESPONSE",
      );
    days.push(...parsed.data.days);
    today = parsed.data.today;
    options.onProgress?.({ completed: ++completed, total });
    from = shiftStatisticsDate(to, 1);
  }
  return { ...range, today, timezone: "Europe/Warsaw", days };
}
