import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { MealForm } from "@/components/app/MealForm";
import { PageHeader } from "@/components/app/ui";
import { MEALS, type MealType } from "@/lib/nutrition/types";
import { useNutrition } from "@/lib/nutrition/store";
const mealIds = MEALS.map((m) => m.id) as string[];
export const Route = createFileRoute("/dodaj")({
  validateSearch: (s: Record<string, unknown>): { meal?: MealType } =>
    typeof s["meal"] === "string" && mealIds.includes(s["meal"])
      ? { meal: s["meal"] as MealType }
      : {},
  head: () => ({
    meta: [
      { title: "Dodaj posiłek · Dziennik Jedzenia" },
      {
        name: "description",
        content: "Złóż posiłek z produktów z własnej bazy i zapisz go w dzienniku.",
      },
    ],
  }),
  component: AddMeal,
});
function AddMeal() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { selectedDate, setSelectedDate } = useNutrition();
  return (
    <div className="animate-rise">
      <PageHeader title="Dodaj posiłek" subtitle="Nowy wpis" />
      <MealForm
        date={selectedDate}
        category={search.meal}
        onSaved={async (date) => {
          setSelectedDate(date);
          await client.invalidateQueries({ queryKey: ["day"] }, { throwOnError: true });
          await navigate({ to: "/", search: { date } });
        }}
      />
    </div>
  );
}
