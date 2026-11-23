import { z } from "zod";
import { apiRequest } from "./client";
import { decimalTextSchema } from "@/lib/contracts/decimal";

const fields = [
  "name",
  "basis_unit",
  "kcal_per_100",
  "protein_per_100",
  "fat_per_100",
  "carbs_per_100",
] as const;
const proposalSchema = z
  .object({
    name: z.string().trim().min(1).max(160).nullable(),
    basis_status: z.enum(["per_100", "per_portion", "unknown"]),
    basis_unit: z.enum(["g", "ml"]).nullable(),
    kcal_per_100: decimalTextSchema.nullable(),
    protein_per_100: decimalTextSchema.nullable(),
    fat_per_100: decimalTextSchema.nullable(),
    carbs_per_100: decimalTextSchema.nullable(),
    missing_fields: z.array(z.enum(fields)),
    warnings: z.array(z.string().max(500)).max(10),
  })
  .strict();

export type LabelProposal = z.infer<typeof proposalSchema>;

export async function readLabelImage(blob: Blob, signal: AbortSignal): Promise<LabelProposal> {
  const body = new FormData();
  body.append("image", blob, "label.jpg");
  const response = await apiRequest<unknown>("/api/v1/label-readings", {
    method: "POST",
    body,
    signal,
  });
  const parsed = proposalSchema.safeParse(response);
  if (!parsed.success)
    throw new Error("Nie udało się odczytać etykiety. Spróbuj ponownie lub wpisz dane ręcznie.");
  // Never suggest portion values as per-100, even if the response is inconsistent.
  return parsed.data.basis_status === "per_100"
    ? parsed.data
    : {
        ...parsed.data,
        kcal_per_100: null,
        protein_per_100: null,
        fat_per_100: null,
        carbs_per_100: null,
      };
}
