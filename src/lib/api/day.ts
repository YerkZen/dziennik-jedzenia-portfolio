import { apiRequest } from "./client";

export interface DayItemDto {
  item_id: string;
  product_id: string;
  source_product_revision: number;
  product_name: string;
  basis_unit: "g" | "ml";
  kcal_per_100: string;
  protein_per_100: string;
  fat_per_100: string;
  carbs_per_100: string;
  quantity: string;
  position: number;
}

export interface DayMealDto {
  id: string;
  name: string;
  entry_date: string;
  category: "breakfast" | "lunch" | "dinner" | "snack";
  revision: number;
  items: DayItemDto[];
  totals: { kcal: string; protein: string; fat: string; carbs: string };
}

export interface DayDto {
  date: string;
  timezone: "Europe/Warsaw";
  meals: DayMealDto[];
  totals: { kcal: string; protein: string; fat: string; carbs: string };
  goals: {
    id: string;
    effective_from: string;
    kcal_goal: string;
    protein_goal: string;
    fat_goal: string;
    carbs_goal: string;
    revision: number;
  } | null;
  remaining_kcal: string | null;
  percentages: { kcal: string; protein: string; fat: string; carbs: string } | null;
}

export function getDay(date: string): Promise<DayDto> {
  return apiRequest<DayDto>(`/api/v1/days/${encodeURIComponent(date)}`);
}
