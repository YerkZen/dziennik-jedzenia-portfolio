import Decimal from "decimal.js";
import { Card } from "./ui";
import { CalorieRing, MACROS } from "./nutrition-ui";
import type { DayDto } from "@/lib/api/day";
import { formatNutritionValue as format } from "@/lib/nutrition/format";
import { cn } from "@/lib/utils";
export function DaySummary({ day }: { day: DayDto }) {
  const goal = day.goals;
  const remaining = new Decimal(day.remaining_kcal ?? "0");
  const over = remaining.lessThan(0);
  const goalValues = goal
    ? { protein: goal.protein_goal, fat: goal.fat_goal, carbs: goal.carbs_goal }
    : null;
  return (
    <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
      <Card className="flex min-w-0 flex-wrap items-center gap-5 p-5">
        <CalorieRing
          value={Number(day.totals.kcal)}
          goal={goal ? Number(goal.kcal_goal) : undefined}
          valueText={format(day.totals.kcal)}
          goalText={goal ? format(goal.kcal_goal) : undefined}
          percentageText={day.percentages ? format(day.percentages.kcal, true) : undefined}
          size={156}
        />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              {goal ? (over ? "Przekroczono o" : "Pozostało") : "Cel dzienny"}
            </p>
            <p
              className={cn(
                "tabular break-words font-display text-3xl font-semibold",
                over ? "text-warning-strong" : "text-primary",
              )}
            >
              {goal ? format(remaining.abs().toString()) : "—"}
              <span className="ml-1 text-sm font-sans text-muted-foreground">
                {goal ? "kcal" : "Brak celu"}
              </span>
            </p>
          </div>
          <div className="text-sm text-muted-foreground">
            {goal && (
              <p>
                Cel{" "}
                <span className="tabular font-semibold text-foreground">
                  {format(goal.kcal_goal)}
                </span>
              </p>
            )}
            <p>
              Spożyto{" "}
              <span className="tabular font-semibold text-foreground">
                {format(day.totals.kcal)}
              </span>
            </p>
            {goal && day.percentages && (
              <p className={cn("tabular font-semibold", over && "text-warning-strong")}>
                {format(day.percentages.kcal, true)} % celu
              </p>
            )}
          </div>
        </div>
      </Card>
      <Card className="min-w-0 space-y-4 p-5">
        <h2 className="text-sm font-bold">Makroskładniki</h2>
        {MACROS.map((macro) => {
          const percent = day.percentages?.[macro.key];
          const clamped = percent === undefined ? 0 : Math.min(100, Math.max(0, Number(percent)));
          return (
            <div key={macro.key}>
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-1 text-sm">
                <span className="font-medium">{macro.label}</span>
                <span className="tabular text-muted-foreground">
                  <span className="font-semibold text-foreground">
                    {format(day.totals[macro.key])}
                  </span>
                  {goalValues ? ` / ${format(goalValues[macro.key])} g` : " · brak celu"}
                </span>
              </div>
              {goalValues && (
                <div
                  role="progressbar"
                  aria-label={macro.label}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={clamped}
                  aria-valuetext={percent ? `${format(percent, true)}%` : undefined}
                  className={cn("h-2 overflow-hidden rounded-full", macro.soft)}
                >
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width] duration-700 ease-out",
                      macro.bar,
                    )}
                    style={{ width: `${clamped}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}
