import { z } from "zod";
import { calendarDateSchema, warsawToday } from "./decimal";

export const STATISTICS_MIN_DATE = "1900-01-01";
export const STATISTICS_PAGE_DAYS = 366;
const DAY_MS = 86_400_000;
const revision = z.number().int().min(0).max(2_147_483_647);

export const statisticsDateSchema = calendarDateSchema.refine(
  (date) => date >= STATISTICS_MIN_DATE && date <= warsawToday(),
  "Wybierz datę od 01.01.1900 do dzisiaj w strefie Europe/Warsaw.",
);

// Validate text before numeric storage can round it; JSON numbers are never accepted.
export const weightKgSchema = z
  .string()
  .regex(
    /^(0|[1-9][0-9]{0,2})(\.[0-9]{1,2})?$/,
    "Wpisz wagę z maksymalnie dwoma miejscami po przecinku.",
  )
  .refine((value) => !/^0(\.0{1,2})?$/.test(value), "Waga musi być większa od zera.");
export const weightFormSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(",", "."))
  .pipe(weightKgSchema);
export const weightWriteSchema = z.object({ weight_kg: weightKgSchema }).strict();

function dateOrdinal(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

export const statisticsRangeSchema = z
  .object({ from: statisticsDateSchema, to: statisticsDateSchema })
  .strict()
  .superRefine(({ from, to }, ctx) => {
    if (from > to)
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "Data Do nie może poprzedzać daty Od.",
      });
    if (dateOrdinal(to) - dateOrdinal(from) + 1 > STATISTICS_PAGE_DAYS)
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "Jedno zapytanie może obejmować najwyżej 366 dni.",
      });
  });

export const statisticsDaySchema = z
  .object({
    date: statisticsDateSchema,
    kcal: z
      .string()
      .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/)
      .nullable(),
    meal_count: z.number().int().nonnegative(),
    weight_kg: weightKgSchema.nullable(),
    weight_revision: revision,
  })
  .strict()
  .superRefine((day, ctx) => {
    if ((day.meal_count === 0) !== (day.kcal === null))
      ctx.addIssue({
        code: "custom",
        path: ["kcal"],
        message: "Brak posiłków wymaga braku danych kcal.",
      });
    if (day.weight_kg !== null && day.weight_revision === 0)
      ctx.addIssue({
        code: "custom",
        path: ["weight_revision"],
        message: "Pomiar musi mieć dodatnią rewizję.",
      });
  });

export const statisticsSchema = statisticsRangeSchema
  .safeExtend({
    today: statisticsDateSchema,
    timezone: z.literal("Europe/Warsaw"),
    days: z.array(statisticsDaySchema).min(1).max(STATISTICS_PAGE_DAYS),
  })
  .superRefine((data, ctx) => {
    const start = dateOrdinal(data.from);
    if (data.to > data.today)
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "Zakres nie może wykraczać poza dzisiaj.",
      });
    if (
      data.days.length !== dateOrdinal(data.to) - start + 1 ||
      data.days.some((day, index) => dateOrdinal(day.date) !== start + index)
    )
      ctx.addIssue({
        code: "custom",
        path: ["days"],
        message: "Odpowiedź musi zawierać każdy dzień zakresu dokładnie raz i w kolejności.",
      });
  });

export const weightMutationSchema = z
  .object({
    date: statisticsDateSchema,
    applied_revision: revision.refine((value) => value > 0),
    current_revision: revision.refine((value) => value > 0),
    replayed: z.boolean(),
    deleted: z.boolean(),
  })
  .strict()
  .refine((value) => value.current_revision >= value.applied_revision, {
    path: ["current_revision"],
    message: "Aktualna rewizja nie może poprzedzać zapisanej rewizji.",
  });

export type StatisticsRange = z.infer<typeof statisticsRangeSchema>;
export type StatisticsDay = z.infer<typeof statisticsDaySchema>;
export type Statistics = z.infer<typeof statisticsSchema>;
export type WeightWrite = z.infer<typeof weightWriteSchema>;
export type WeightMutation = z.infer<typeof weightMutationSchema>;
