import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { Btn, Card, Field } from "@/components/app/ui";
import { ApiRequestError } from "@/lib/api/client";
import {
  defaultStatisticsRange,
  getStatistics,
  statisticsDateLabel,
  statisticsSelectionSchema,
  type StatisticsProgress,
} from "@/lib/api/statistics";
import { warsawToday } from "@/lib/contracts/decimal";
import type { StatisticsDay } from "@/lib/contracts/statistics";
import { formatNutritionValue } from "@/lib/nutrition/format";
import { StatisticsCharts } from "./StatisticsCharts";
import { WeightMeasurements } from "./WeightMeasurements";

export default function ProfileStatistics({ ownerId }: { ownerId: string }) {
  const [today, setToday] = useState(warsawToday);
  const [selection, setSelection] = useState(() => {
    const range = defaultStatisticsRange(warsawToday());
    return { range, draft: range, manual: false };
  });
  const [error, setError] = useState("");
  const [retrySeconds, setRetrySeconds] = useState(0);
  const [progress, setProgress] = useState<StatisticsProgress & { key: string }>({
    completed: 0,
    total: 0,
    key: "",
  });
  const key = `${selection.range.from}/${selection.range.to}`;
  const query = useQuery({
    queryKey: ["statistics", ownerId, selection.range.from, selection.range.to],
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) =>
      getStatistics(selection.range, {
        signal,
        onProgress: (next) => {
          if (!signal.aborted) setProgress({ ...next, key });
        },
      }),
  });
  useEffect(() => {
    const delay = query.error instanceof ApiRequestError ? (query.error.retryAfterSeconds ?? 0) : 0;
    const deadline = Date.now() + delay * 1000;
    setRetrySeconds(delay);
    if (!delay) return;
    const timer = window.setInterval(
      () => setRetrySeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000))),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [query.errorUpdatedAt, query.error]);
  useEffect(() => {
    const refreshToday = () => {
      const next = warsawToday();
      setToday(next);
      setSelection((current) =>
        current.manual ||
        current.draft.from !== current.range.from ||
        current.draft.to !== current.range.to
          ? current
          : {
              range: defaultStatisticsRange(next),
              draft: defaultStatisticsRange(next),
              manual: false,
            },
      );
    };
    window.addEventListener("focus", refreshToday);
    return () => window.removeEventListener("focus", refreshToday);
  }, []);
  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = statisticsSelectionSchema.safeParse(selection.draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Sprawdź zakres dat.");
      return;
    }
    setError("");
    setSelection({ range: parsed.data, draft: parsed.data, manual: true });
  }
  return (
    <Card className="mt-4 min-h-[680px] min-w-0 p-5">
      <section aria-labelledby="profile-statistics-heading">
        <div className="mb-4 flex items-center gap-2">
          <BarChart3 aria-hidden="true" className="h-5 w-5 text-primary" />
          <h2 id="profile-statistics-heading" className="font-bold">
            Statystyki
          </h2>
        </div>
        <form onSubmit={submit} noValidate className="mb-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {(["from", "to"] as const).map((field) => (
              <Field
                key={field}
                label={field === "from" ? "Od" : "Do"}
                type="date"
                min="1900-01-01"
                max={today}
                value={selection.draft[field]}
                onChange={(event) => {
                  const value = event.target.value;
                  setSelection((current) => ({
                    ...current,
                    draft: { ...current.draft, [field]: value },
                  }));
                  setError("");
                }}
              />
            ))}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive-strong">
              {error}
            </p>
          )}
          <Btn type="submit" className="w-full">
            Pokaż
          </Btn>
        </form>
        <WeightMeasurements
          ownerId={ownerId}
          today={today}
          days={query.data?.days ?? []}
          available={!query.isFetching && !query.isError && !!query.data}
          rangeKey={key}
        />
        {query.isFetching || query.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Wczytuję statystyki…
            {progress.key === key && progress.total > 1
              ? ` ${progress.completed}/${progress.total}`
              : ""}
          </p>
        ) : query.isError ? (
          <div role="alert" className="space-y-3">
            <p>
              Nie udało się wczytać statystyk.{" "}
              {query.error instanceof ApiRequestError ? query.error.message : "Sprawdź połączenie."}
            </p>
            <Btn variant="outline" disabled={retrySeconds > 0} onClick={() => void query.refetch()}>
              {retrySeconds > 0 ? `Ponów za ${retrySeconds} s` : "Ponów"}
            </Btn>
          </div>
        ) : query.data ? (
          <>
            <p className="mb-4 text-xs text-muted-foreground">
              Wyświetlany okres: {statisticsDateLabel(selection.range.from)} –{" "}
              {statisticsDateLabel(selection.range.to)}
            </p>
            <StatisticsCharts days={query.data.days} today={today} />
            <StatisticsData key={key} days={query.data.days} today={today} />
          </>
        ) : null}
      </section>
    </Card>
  );
}
function StatisticsData({ days, today }: { days: StatisticsDay[]; today: string }) {
  const [page, setPage] = useState(0);
  const last = Math.max(0, Math.ceil(days.length / 30) - 1);
  const rows = days.slice(page * 30, (page + 1) * 30);
  return (
    <div className="mt-5 border-t border-border pt-4">
      <h3 className="mb-2 font-semibold">Dane dzienne</h3>
      <table
        aria-label="Dane statystyk"
        className="w-full table-fixed text-left text-xs sm:text-sm"
      >
        <thead>
          <tr>
            <th scope="col" className="w-[44%] py-2">
              Dzień
            </th>
            <th scope="col">Kalorie</th>
            <th scope="col">Waga</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((day) => (
            <tr key={day.date} className="border-t border-border/60">
              <th scope="row" className="py-3 pr-1 font-medium">
                {statisticsDateLabel(day.date)}
                {day.date === today && (
                  <span className="block text-xs font-normal text-muted-foreground">
                    dzień trwa
                  </span>
                )}
              </th>
              <td className="break-words pr-1 tabular-nums">
                {day.kcal === null ? "Brak danych" : `${formatNutritionValue(day.kcal)} kcal`}
              </td>
              <td className="break-words tabular-nums">
                {day.weight_kg === null
                  ? "Brak danych"
                  : `${formatNutritionValue(day.weight_kg)} kg`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {last > 0 && (
        <nav
          aria-label="Strony danych statystyk"
          className="mt-3 flex flex-wrap items-center justify-between gap-2"
        >
          <Btn
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
            aria-label="Poprzednie dni"
          >
            ←
          </Btn>
          <span aria-live="polite" className="text-xs">
            {page + 1} / {last + 1}
          </span>
          <Btn
            variant="outline"
            disabled={page === last}
            onClick={() => setPage(page + 1)}
            aria-label="Kolejne dni"
          >
            →
          </Btn>
          <Btn
            variant="ghost"
            disabled={page === last}
            onClick={() => setPage(last)}
            aria-label="Ostatnia strona danych"
          >
            Ostatnia strona
          </Btn>
        </nav>
      )}
    </div>
  );
}
