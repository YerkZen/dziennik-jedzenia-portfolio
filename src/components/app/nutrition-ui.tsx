import { formatNutritionValue } from "@/lib/nutrition/format";
import { progress } from "@/lib/nutrition/calc";
import type { Nutrients } from "@/lib/nutrition/types";
import { cn } from "@/lib/utils";

export const MACROS = [
  {
    key: "protein",
    label: "Białko",
    short: "B",
    bar: "bg-protein",
    soft: "bg-protein-soft",
    text: "text-protein-strong",
  },
  {
    key: "fat",
    label: "Tłuszcze",
    short: "T",
    bar: "bg-fat",
    soft: "bg-fat-soft",
    text: "text-fat-strong",
  },
  {
    key: "carbs",
    label: "Węglowodany",
    short: "W",
    bar: "bg-carbs",
    soft: "bg-carbs-soft",
    text: "text-carbs-strong",
  },
] as const;

export function CalorieRing({
  value,
  goal,
  size = 176,
  valueText,
  goalText,
  percentageText,
}: {
  value: number;
  goal?: number | undefined;
  size?: number;
  valueText?: string | undefined;
  goalText?: string | undefined;
  percentageText?: string | undefined;
}) {
  const stroke = 14;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = goal ? progress(value, goal) : 0;
  const over = goal !== undefined && value > goal;
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role={goal === undefined ? undefined : "progressbar"}
      aria-label={goal === undefined ? undefined : "Kalorie"}
      aria-valuemin={goal === undefined ? undefined : 0}
      aria-valuemax={goal === undefined ? undefined : 100}
      aria-valuenow={goal === undefined ? undefined : Math.min(100, Math.max(0, p * 100))}
      aria-valuetext={
        goal === undefined
          ? undefined
          : `${valueText ?? formatNutritionValue(String(value))} z ${goalText ?? formatNutritionValue(String(goal))} kcal${percentageText ? `, ${percentageText}%` : ""}`
      }
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-primary-soft"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p)}
          className={cn(
            "transition-[stroke-dashoffset] duration-700 ease-out",
            over ? "stroke-warning" : "stroke-primary",
          )}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className={cn(
            "tabular max-w-[90%] break-words font-display font-semibold leading-none",
            (valueText?.length ?? 0) > 8 ? "text-xl" : "text-4xl",
          )}
        >
          {valueText ?? formatNutritionValue(String(value))}
        </span>
        <span className="mt-1 text-xs text-muted-foreground">
          {goal ? `z ${goalText ?? formatNutritionValue(String(goal))} kcal` : "Spożyto"}
        </span>
      </div>
    </div>
  );
}

export function MacroBar({
  label,
  value,
  goal,
  bar,
  soft,
}: {
  label: string;
  value: number;
  goal?: number | undefined;
  bar: string;
  soft: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular text-muted-foreground">
          <span className="font-semibold text-foreground">
            {formatNutritionValue(String(value))}
          </span>
          {goal === undefined ? " · brak celu" : <> / {formatNutritionValue(String(goal))} g</>}
        </span>
      </div>
      {goal !== undefined && (
        <div
          className={cn("h-2 overflow-hidden rounded-full", soft)}
          role="progressbar"
          aria-label={label}
          aria-valuenow={Math.round(value)}
          aria-valuemax={goal}
        >
          <div
            className={cn("h-full rounded-full transition-[width] duration-700 ease-out", bar)}
            style={{ width: `${progress(value, goal) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function MacroChips({ n, className }: { n: Nutrients; className?: string }) {
  return (
    <div
      className={cn(
        "tabular flex flex-wrap gap-x-2.5 gap-y-1 text-xs text-muted-foreground",
        className,
      )}
    >
      {MACROS.map((m) => (
        <span key={m.key} className="inline-flex items-center gap-1">
          <span className={cn("h-1.5 w-1.5 rounded-full", m.bar)} />
          {m.short} {formatNutritionValue(String(n[m.key]))}
        </span>
      ))}
    </div>
  );
}

export function NutrientSummary({ n }: { n: Nutrients }) {
  return (
    <div className="grid grid-cols-4 gap-2 text-center">
      <div className="rounded-xl bg-primary-soft px-1 py-2.5">
        <p className="tabular text-lg font-bold text-accent-foreground">
          {formatNutritionValue(String(n.kcal))}
        </p>
        <p className="text-[11px] text-muted-foreground">kcal</p>
      </div>
      {MACROS.map((m) => (
        <div key={m.key} className={cn("rounded-xl px-1 py-2.5", m.soft)}>
          <p className={cn("tabular text-lg font-bold", m.text)}>
            {formatNutritionValue(String(n[m.key]))}
          </p>
          <p className="text-[11px] text-muted-foreground">{m.label.toLowerCase()}</p>
        </div>
      ))}
    </div>
  );
}
