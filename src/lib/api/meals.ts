import { apiRequest } from "./client";
import type { DayMealDto } from "./day";
import type { MutationAck } from "./products";
export interface NewMealItem {
  kind: "new";
  item_id: string;
  product_id: string;
  expected_product_revision: number;
  quantity: string;
}
export interface ExistingMealItem {
  kind: "existing";
  item_id: string;
  quantity: string;
}
export interface MealInput {
  source_template?: { id: string; revision: number };
  name: string;
  entry_date: string;
  category: DayMealDto["category"];
  items: (NewMealItem | ExistingMealItem)[];
}
export function getMeal(id: string) {
  return apiRequest<DayMealDto>(`/api/v1/diary-meals/${encodeURIComponent(id)}`);
}
export function saveMeal(id: string, revision: number | null, input: MealInput, key: string) {
  return apiRequest<MutationAck>(
    `/api/v1/diary-meals${revision === null ? "" : `/${encodeURIComponent(id)}`}`,
    {
      method: revision === null ? "POST" : "PUT",
      headers: {
        "Idempotency-Key": key,
        ...(revision === null ? {} : { "If-Match": `"${revision}"` }),
      },
      body: JSON.stringify(revision === null ? { id, ...input } : input),
    },
  );
}
export function deleteMeal(id: string, revision: number, key: string) {
  return apiRequest<MutationAck>(`/api/v1/diary-meals/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "If-Match": `"${revision}"`, "Idempotency-Key": key },
  });
}
