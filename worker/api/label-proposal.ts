import { z } from "zod";

const MAX_MODEL_OUTPUT_BYTES = 16 * 1024;
const DECIMAL_TEXT_PATTERN = /^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$/;
const decimalTextSchema = z.union([
  z.string().regex(DECIMAL_TEXT_PATTERN),
  z
    .number()
    .finite()
    .nonnegative()
    .refine((value) => DECIMAL_TEXT_PATTERN.test(String(value)))
    .transform(String),
]);

const modelProposalSchema = z
  .object({
    name: z.string().trim().max(160).nullable().optional(),
    basis_status: z.enum(["per_100", "per_portion", "unknown"]).optional(),
    basis_unit: z.enum(["g", "ml"]).nullable().optional(),
    energy_unit: z.enum(["kcal", "kj"]).nullable().optional(),
    kcal_per_100: decimalTextSchema.nullable().optional(),
    protein_per_100: decimalTextSchema.nullable().optional(),
    fat_per_100: decimalTextSchema.nullable().optional(),
    carbs_per_100: decimalTextSchema.nullable().optional(),
  })
  .strict();

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string(),
        message: z.object({
          content: z.string().nullable(),
          refusal: z.string().nullable().optional(),
          tool_calls: z.array(z.unknown()).optional(),
        }),
      }),
    )
    .length(1),
});

export type LabelProposal = {
  name: string | null;
  basis_status: "per_100" | "per_portion" | "unknown";
  basis_unit: "g" | "ml" | null;
  kcal_per_100: string | null;
  protein_per_100: string | null;
  fat_per_100: string | null;
  carbs_per_100: string | null;
  missing_fields: Array<
    "name" | "basis_unit" | "kcal_per_100" | "protein_per_100" | "fat_per_100" | "carbs_per_100"
  >;
  warnings: string[];
};

const NUTRIENT_FIELDS = [
  "kcal_per_100",
  "protein_per_100",
  "fat_per_100",
  "carbs_per_100",
] as const;

export function parseLabelModelOutput(output: unknown): LabelProposal | null {
  const completion = completionSchema.safeParse(output);
  if (!completion.success) return null;

  const choice = completion.data.choices[0];
  if (
    !choice ||
    choice.finish_reason !== "stop" ||
    choice.message.content === null ||
    choice.message.refusal ||
    (choice.message.tool_calls?.length ?? 0) > 0
  ) {
    return null;
  }

  if (new TextEncoder().encode(choice.message.content).byteLength > MAX_MODEL_OUTPUT_BYTES)
    return null;

  let rawProposal: unknown;
  try {
    rawProposal = JSON.parse(choice.message.content);
  } catch {
    return null;
  }

  const parsed = modelProposalSchema.safeParse(rawProposal);
  if (!parsed.success) return null;

  const status = parsed.data.basis_status ?? "unknown";
  const name = parsed.data.name?.trim() || null;
  const basisUnit = parsed.data.basis_unit ?? null;
  const energyIsKj = parsed.data.energy_unit === "kj";
  const perHundred = status === "per_100";
  const nutrients: Record<(typeof NUTRIENT_FIELDS)[number], string | null> = {
    kcal_per_100: perHundred && !energyIsKj ? (parsed.data.kcal_per_100 ?? null) : null,
    protein_per_100: perHundred ? (parsed.data.protein_per_100 ?? null) : null,
    fat_per_100: perHundred ? (parsed.data.fat_per_100 ?? null) : null,
    carbs_per_100: perHundred ? (parsed.data.carbs_per_100 ?? null) : null,
  };

  const missingFields: LabelProposal["missing_fields"] = [];
  if (!name) missingFields.push("name");
  if (!basisUnit) missingFields.push("basis_unit");
  for (const field of NUTRIENT_FIELDS) if (nutrients[field] === null) missingFields.push(field);

  const warnings: string[] = [];
  if (status === "per_portion")
    warnings.push("Etykieta podaje wartości na porcję. Wpisz wartości na 100 g lub 100 ml.");
  if (status === "unknown")
    warnings.push("Nie udało się ustalić podstawy wartości. Wpisz wartości na 100 g lub 100 ml.");
  if (energyIsKj) warnings.push("Energia jest podana w kJ. Wpisz wartość w kcal.");

  return {
    name,
    basis_status: status,
    basis_unit: basisUnit,
    ...nutrients,
    missing_fields: missingFields,
    warnings,
  };
}
