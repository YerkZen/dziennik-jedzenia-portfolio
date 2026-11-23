import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Btn, Card, Sheet } from "./ui";
import { MealForm } from "./MealForm";
import { deleteMeal, getMeal } from "@/lib/api/meals";
import type { DayDto, DayMealDto } from "@/lib/api/day";
import { MEALS } from "@/lib/nutrition/types";
import { formatNutritionValue as format } from "@/lib/nutrition/format";

export function MealCards({ day }: { day: DayDto }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<DayMealDto | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const deleteKeys = useRef(new Map<string, string>());
  async function remove(meal: DayMealDto) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    const signature = `${meal.id}:${meal.revision}`;
    const key = deleteKeys.current.get(signature) ?? crypto.randomUUID();
    deleteKeys.current.set(signature, key);
    let saved = false;
    try {
      await deleteMeal(meal.id, meal.revision, key);
      saved = true;
      setStatus("Posiłek usunięty.");
      await client.invalidateQueries({ queryKey: ["day"] }, { throwOnError: true });
    } catch {
      setError(
        saved
          ? "Posiłek usunięty. Nie udało się odświeżyć dnia."
          : "Nie potwierdzono usunięcia. Spróbuj ponownie.",
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <h2 className="mb-3 mt-7 text-lg font-bold">Posiłki</h2>
      {status && <p role="status">{status}</p>}
      {error && (
        <p role="alert" className="mb-3 text-sm text-destructive-strong">
          {error}
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {MEALS.map((category) => (
          <Card key={category.id} className="min-w-0 overflow-hidden">
            <div className="flex items-center gap-3 p-4">
              <span
                className="grid h-10 w-10 place-items-center rounded-xl bg-muted text-lg"
                aria-hidden
              >
                {category.emoji}
              </span>
              <h3 className="min-w-0 flex-1 font-semibold">{category.label}</h3>
              <Link
                to="/dodaj"
                search={{ meal: category.id }}
                aria-label={`Dodaj do: ${category.label}`}
                className="grid h-11 w-11 place-items-center rounded-xl bg-primary-soft text-primary"
              >
                <Plus className="h-5 w-5" />
              </Link>
            </div>
            {day.meals
              .filter((meal) => meal.category === category.id)
              .map((meal) => (
                <article key={meal.id} aria-label={meal.name} className="border-t p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <h4 className="min-w-0 flex-1 break-words text-sm font-semibold">
                      {meal.name}
                    </h4>
                    <span className="tabular shrink-0 text-sm font-semibold">
                      {format(meal.totals.kcal)} kcal
                    </span>
                    <Btn
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Edytuj posiłek: ${meal.name}`}
                      disabled={busy}
                      onClick={() => {
                        setError("");
                        void getMeal(meal.id)
                          .then(setEditing)
                          .catch(() => setError("Nie udało się wczytać posiłku."));
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                    </Btn>
                    <Btn
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Usuń posiłek: ${meal.name}`}
                      onClick={() => void remove(meal)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Btn>
                  </div>
                  <ul className="space-y-2">
                    {meal.items.map((item) => (
                      <li
                        key={item.item_id}
                        className="flex items-baseline justify-between gap-3 text-sm"
                      >
                        <span className="min-w-0 break-words">{item.product_name}</span>
                        <span className="tabular shrink-0 text-muted-foreground">
                          {format(item.quantity)} {item.basis_unit}
                        </span>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            {!day.meals.some((meal) => meal.category === category.id) && (
              <p className="px-4 pb-4 text-xs text-muted-foreground">Brak wpisów</p>
            )}
          </Card>
        ))}
      </div>
      <Sheet open={editing !== null} title="Edytuj posiłek" onClose={() => setEditing(null)}>
        {editing && (
          <MealForm
            key={`${editing.id}:${editing.revision}`}
            initial={editing}
            date={editing.entry_date}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              await client.invalidateQueries({ queryKey: ["day"] }, { throwOnError: true });
              setEditing(null);
            }}
          />
        )}
      </Sheet>
    </>
  );
}
