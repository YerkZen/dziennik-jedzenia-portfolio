export type MealType = "breakfast" | "lunch" | "dinner" | "snack";

export interface Nutrients {
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
}

/** Product with nutrition values per 100 g. */
export interface Product extends Nutrients {
  id: string;
  name: string;
  basisUnit?: "g" | "ml" | undefined;
}

export interface DiaryEntry {
  id: string;
  date: string; // YYYY-MM-DD
  meal: MealType;
  productId: string;
  grams: number;
}

export interface ProductSetItem {
  productId: string;
  grams: number;
}

export interface ProductSet {
  id: string;
  name: string;
  items: ProductSetItem[];
}

export type Goals = Nutrients;

export const MEALS: { id: MealType; label: string; emoji: string }[] = [
  { id: "breakfast", label: "Śniadanie", emoji: "☀️" },
  { id: "lunch", label: "Obiad", emoji: "🍲" },
  { id: "dinner", label: "Kolacja", emoji: "🌙" },
  { id: "snack", label: "Przekąski", emoji: "🍎" },
];
