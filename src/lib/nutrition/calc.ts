import type { Nutrients, Product } from "./types";
import { formatDecimalHalfUp } from "@/lib/contracts/decimal";
import { portionExact, sumExact, toDisplayNutrients, type DecimalNutrients } from "./decimal";

export const ZERO: Nutrients = { kcal: 0, protein: 0, fat: 0, carbs: 0 };

/** Scale per-100 g values of a product to a given portion in grams. */
export function forPortion(product: Nutrients, grams: number): Nutrients {
  return toDisplayNutrients(portionExact(product, grams));
}

export function sum(list: Nutrients[]): Nutrients {
  return toDisplayNutrients(
    sumExact(
      list.map((item) => ({
        kcal: String(item.kcal),
        protein: String(item.protein),
        fat: String(item.fat),
        carbs: String(item.carbs),
      })),
    ),
  );
}

export function totalFor(
  items: { productId: string; grams: number }[],
  products: Product[],
): Nutrients {
  const map = new Map(products.map((p) => [p.id, p]));
  return toDisplayNutrients(totalForExact(items, products, map));
}

export function totalForExact(
  items: { productId: string; grams: number }[],
  products: Product[],
  productMap = new Map(products.map((product) => [product.id, product])),
): DecimalNutrients {
  return sumExact(
    items.flatMap((item) => {
      const product = productMap.get(item.productId);
      return product ? [portionExact(product, item.grams)] : [];
    }),
  );
}

export function progress(value: number, goal: number): number {
  if (goal <= 0) return 0;
  return Math.min(1, Math.max(0, value / goal));
}

export const fmt = (n: number) => Number(formatDecimalHalfUp(n, 0)).toLocaleString("pl-PL");
export const fmt1 = (n: number) =>
  Number(formatDecimalHalfUp(n, 1)).toLocaleString("pl-PL", { maximumFractionDigits: 1 });

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function shiftDate(iso: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = iso.split("-").map(Number);
  return toISODate(new Date(y, m - 1, d + days));
}

export function parseISO(iso: string): Date {
  const [y = 1970, m = 1, d = 1] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
