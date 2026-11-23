import Decimal from "decimal.js";
import { formDecimalTextSchema } from "@/lib/contracts/decimal";
import type { Nutrients } from "./types";

export type DecimalNutrients = Record<keyof Nutrients, string>;
type DecimalValues = Record<keyof Nutrients, Decimal.Value>;
const KEYS: (keyof Nutrients)[] = ["kcal", "protein", "fat", "carbs"];

export function portionExact(nutrients: DecimalValues, quantity: Decimal.Value): DecimalNutrients {
  const safeQuantity = Decimal.max(0, new Decimal(quantity));
  return Object.fromEntries(
    KEYS.map((key) => [key, new Decimal(nutrients[key]).times(safeQuantity).div(100).toString()]),
  ) as DecimalNutrients;
}

export function sumExact(values: DecimalNutrients[]): DecimalNutrients {
  return Object.fromEntries(
    KEYS.map((key) => [
      key,
      values.reduce((sum, value) => sum.plus(value[key]), new Decimal(0)).toString(),
    ]),
  ) as DecimalNutrients;
}

export function macroEnergyExact(protein: string, fat: string, carbs: string): string | null {
  const parsed = [protein, fat, carbs].map((value) => formDecimalTextSchema.safeParse(value));
  if (parsed.some((result) => !result.success)) return null;
  const [proteinValue, fatValue, carbsValue] = parsed.map((result) =>
    result.success ? result.data : "0",
  );
  return new Decimal(proteinValue ?? "0")
    .times(4)
    .plus(new Decimal(fatValue ?? "0").times(9))
    .plus(new Decimal(carbsValue ?? "0").times(4))
    .toString();
}

export function toDisplayNutrients(values: DecimalNutrients): Nutrients {
  return {
    kcal: new Decimal(values.kcal).toNumber(),
    protein: new Decimal(values.protein).toNumber(),
    fat: new Decimal(values.fat).toNumber(),
    carbs: new Decimal(values.carbs).toNumber(),
  };
}
