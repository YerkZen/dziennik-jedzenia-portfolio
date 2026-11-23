import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { StatisticsDay } from "@/lib/contracts/statistics";
import { statisticsDateLabel } from "@/lib/api/statistics";
import { formatNutritionValue } from "@/lib/nutrition/format";

export function StatisticsCharts({ days, today }: { days: StatisticsDay[]; today: string }) {
  const points = days.map((day) => ({
    ...day,
    kcalPlot: day.kcal === null ? null : Number(day.kcal),
    weightPlot: day.weight_kg === null ? null : Number(day.weight_kg),
  }));
  return (
    <div className="space-y-6">
      {(["kcal", "weight_kg"] as const).map((metric) => {
        const calories = metric === "kcal";
        const hasData = days.some((day) => day[metric] !== null);
        const title = calories ? "Dzienne kalorie" : "Waga";
        const axis = [
          <CartesianGrid key="grid" vertical={false} stroke="var(--border)" />,
          <XAxis
            key="x"
            interval="preserveStartEnd"
            dataKey="date"
            tickFormatter={(date: string) => `${date.slice(8)}.${date.slice(5, 7)}`}
            minTickGap={32}
            tick={{ fontSize: 11 }}
            tickLine={false}
          />,
          <YAxis
            key="y"
            tickFormatter={(value: number) => formatNutritionValue(String(value))}
            width={52}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            domain={calories ? [0, "auto"] : ["auto", "auto"]}
          />,
          <Tooltip
            key="tooltip"
            content={({ active, payload }) => {
              const point = payload?.[0]?.payload as StatisticsDay | undefined;
              return active && point && point[metric] !== null ? (
                <div className="rounded-xl border border-border bg-card p-3 text-sm shadow-sm">
                  <p>
                    {statisticsDateLabel(point.date)}
                    {point.date === today ? " · dzień trwa" : ""}
                  </p>
                  <p className="font-bold tabular-nums">
                    {formatNutritionValue(point[metric])} {calories ? "kcal" : "kg"}
                  </p>
                </div>
              ) : null;
            }}
          />,
        ];
        return (
          <section key={metric} aria-label={title}>
            <h3 className="mb-2 font-semibold">{title}</h3>
            {!hasData ? (
              <p className="rounded-xl bg-muted/50 p-4 text-sm text-muted-foreground">
                {calories
                  ? "Brak zapisanych posiłków w wybranym okresie."
                  : "Brak pomiarów wagi w wybranym okresie."}
              </p>
            ) : (
              <ChartFrame label={calories ? title : "Historia wagi"}>
                <ResponsiveContainer
                  width="100%"
                  height={240}
                  minWidth={0}
                  initialDimension={{ width: 320, height: 240 }}
                >
                  {calories ? (
                    <BarChart data={points} accessibilityLayer>
                      {axis}
                      <Bar
                        dataKey="kcalPlot"
                        name="Kalorie"
                        fill="var(--chart-1)"
                        radius={[3, 3, 0, 0]}
                        isAnimationActive={false}
                      />
                    </BarChart>
                  ) : (
                    <LineChart data={points} accessibilityLayer>
                      {axis}
                      <Line
                        dataKey="weightPlot"
                        name="Waga"
                        stroke="var(--chart-2)"
                        strokeWidth={2}
                        connectNulls
                        dot={(dotProps) => {
                          const point = dotProps.payload as StatisticsDay | undefined;
                          if (!point || point.weight_kg === null) return <g />;
                          return (
                            <g
                              key={point.date}
                              className="recharts-line-dot"
                              tabIndex={0}
                              role="img"
                              aria-label={`Pomiar wagi ${formatNutritionValue(point.weight_kg)} kg z ${statisticsDateLabel(point.date)}`}
                            >
                              <circle
                                cx={dotProps.cx}
                                cy={dotProps.cy}
                                r={5}
                                fill="var(--chart-2)"
                                stroke="var(--card)"
                                strokeWidth={2}
                              />
                              <title>{`${statisticsDateLabel(point.date)} · ${formatNutritionValue(point.weight_kg)} kg`}</title>
                            </g>
                          );
                        }}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  )}
                </ResponsiveContainer>
              </ChartFrame>
            )}
            {calories && (
              <p className="mt-2 text-xs text-muted-foreground">
                Puste dni oznaczają brak danych. Dzisiejszy dzień trwa.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

function ChartFrame({ label, children }: { label: string; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (visible || !frame.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "160px 0px" },
    );
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [visible]);
  return (
    <div
      ref={frame}
      role="img"
      aria-label={label}
      aria-busy={!visible}
      className="h-60 min-w-0 w-full"
    >
      {visible ? children : null}
    </div>
  );
}
