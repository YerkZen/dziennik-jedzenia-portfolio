import Decimal from "decimal.js";
import { z } from "zod";

export const DECIMAL_10_2_PATTERN = /^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$/;
export const DECIMAL_10_2_MAX = "99999999.99";

const decimalTextMessage =
  "Wartość musi mieć najwyżej 2 miejsca po przecinku i mieścić się w zakresie 0–99999999.99";

/** Exact wire representation from OpenAPI: a non-negative decimal string using a dot. */
export const decimalTextSchema = z.string().regex(DECIMAL_10_2_PATTERN, decimalTextMessage);

export const positiveDecimalTextSchema = decimalTextSchema.refine(
  (value) => new Decimal(value).greaterThan(0),
  "Wartość musi być większa od 0",
);

/** Form values may use a comma; this parser never accepts JSON numbers or exponents. */
export const formDecimalTextSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(",", "."))
  .pipe(decimalTextSchema);

export const positiveFormDecimalTextSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(",", "."))
  .refine(
    (value) => DECIMAL_10_2_PATTERN.test(value) && new Decimal(value).greaterThan(0),
    "Wpisz poprawną liczbę większą od 0",
  );

export function decimalToNumber(value: string): number {
  return new Decimal(value).toNumber();
}

export function formatDecimalHalfUp(value: Decimal.Value, decimalPlaces = 2): string {
  return new Decimal(value).toDecimalPlaces(decimalPlaces, Decimal.ROUND_HALF_UP).toFixed();
}

const warsawDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Warsaw",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function warsawToday(now: Date = new Date()): string {
  const parts = warsawDateFormatter.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export const uuidSchema = z.string().uuid();

export const nameSchema = z
  .string()
  .trim()
  .min(1, "Podaj nazwę")
  .max(160, "Nazwa może mieć maksymalnie 160 znaków");

export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Podaj datę YYYY-MM-DD")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    if (!year || !month || !day) return false;
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, "Podaj istniejącą datę kalendarzową");

export const diaryDateSchema = calendarDateSchema.refine(
  (value) => value <= warsawToday(),
  "Data nie może być przyszła w strefie Europe/Warsaw",
);

export const goalsExpectedDateSchema = calendarDateSchema.refine(
  (value) => value === warsawToday(),
  "Cele można zapisać wyłącznie dla dzisiejszej daty w strefie Europe/Warsaw",
);

export const revisionSchema = z.number().int().min(1).max(2_147_483_647);

const basisUnitSchema = z.enum(["g", "ml"]);
const nutrientFields = {
  kcal_per_100: decimalTextSchema,
  protein_per_100: decimalTextSchema,
  fat_per_100: decimalTextSchema,
  carbs_per_100: decimalTextSchema,
};

export const productCreateSchema = z
  .object({
    id: uuidSchema,
    name: nameSchema,
    basis_unit: basisUnitSchema,
    ...nutrientFields,
  })
  .strict();

export const productUpdateSchema = z
  .object({
    name: nameSchema,
    ...nutrientFields,
  })
  .strict();

const revisionInputSchema = z.number().int().min(1).max(2_147_483_647);
const templateSourceSchema = z.object({ id: uuidSchema, revision: revisionInputSchema }).strict();

const templateIngredientSchema = z
  .object({
    item_id: uuidSchema,
    product_id: uuidSchema,
    expected_product_revision: revisionInputSchema,
    quantity: positiveDecimalTextSchema,
  })
  .strict();

export const templateCreateSchema = z
  .object({
    id: uuidSchema,
    name: nameSchema,
    items: z.array(templateIngredientSchema).min(1),
  })
  .strict();

export const templateUpdateSchema = z
  .object({ name: nameSchema, items: z.array(templateIngredientSchema).min(1) })
  .strict();

const newDiaryItemSchema = z
  .object({
    kind: z.literal("new"),
    item_id: uuidSchema,
    product_id: uuidSchema,
    expected_product_revision: revisionInputSchema,
    quantity: positiveDecimalTextSchema,
  })
  .strict();

const existingDiaryItemSchema = z
  .object({ kind: z.literal("existing"), item_id: uuidSchema, quantity: positiveDecimalTextSchema })
  .strict();

const mealCategorySchema = z.enum(["breakfast", "lunch", "dinner", "snack"]);

export const mealCreateSchema = z
  .object({
    id: uuidSchema,
    name: nameSchema,
    entry_date: diaryDateSchema,
    category: mealCategorySchema,
    source_template: templateSourceSchema.optional(),
    items: z.array(newDiaryItemSchema).min(1),
  })
  .strict();

export const mealUpdateSchema = z
  .object({
    name: nameSchema,
    entry_date: diaryDateSchema,
    category: mealCategorySchema,
    items: z.array(z.union([existingDiaryItemSchema, newDiaryItemSchema])).min(1),
  })
  .strict();

export const goalsWriteSchema = z
  .object({
    id: uuidSchema,
    expected_date: goalsExpectedDateSchema,
    kcal_goal: positiveDecimalTextSchema,
    protein_goal: positiveDecimalTextSchema,
    fat_goal: positiveDecimalTextSchema,
    carbs_goal: positiveDecimalTextSchema,
  })
  .strict();
