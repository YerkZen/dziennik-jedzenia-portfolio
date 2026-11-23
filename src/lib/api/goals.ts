import { apiRequest } from "./client";
import type { MutationAck } from "./products";
export interface GoalVersionDto {
  id: string;
  effective_from: string;
  kcal_goal: string;
  protein_goal: string;
  fat_goal: string;
  carbs_goal: string;
  revision: number;
}
export interface GoalViewDto {
  date: string;
  current: GoalVersionDto | null;
  today_id: string | null;
  today_revision: number;
}
export interface GoalsInput {
  id: string;
  expected_date: string;
  kcal_goal: string;
  protein_goal: string;
  fat_goal: string;
  carbs_goal: string;
}
export function getGoals(): Promise<GoalViewDto> {
  return apiRequest<GoalViewDto>("/api/v1/goals");
}
export function saveGoals(input: GoalsInput, revision: number, key: string): Promise<MutationAck> {
  return apiRequest<MutationAck>("/api/v1/goals/today", {
    method: "PUT",
    headers: { "If-Match": `"${revision}"`, "Idempotency-Key": key },
    body: JSON.stringify(input),
  });
}
