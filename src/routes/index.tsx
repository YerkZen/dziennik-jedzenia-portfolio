import { useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Leaf, Plus, ScanLine } from "lucide-react";
import { DaySummary } from "@/components/app/DaySummary";
import { MealCards } from "@/components/app/MealCards";
import { Btn, Card } from "@/components/app/ui";
import { getDay } from "@/lib/api/day";
import { diaryDateSchema, warsawToday } from "@/lib/contracts/decimal";
import { parseISO, shiftDate } from "@/lib/nutrition/calc";
import { useNutrition } from "@/lib/nutrition/store";

export const Route = createFileRoute("/")({
  validateSearch: (input: Record<string, unknown>): { date?: string } =>
    diaryDateSchema.safeParse(input["date"]).success ? { date: input["date"] as string } : {},
  head: () => ({
    meta: [
      { title: "Dzisiaj · Dziennik Jedzenia" },
      {
        name: "description",
        content: "Dzienny bilans kalorii, makroskładniki i posiłki w jednym miejscu.",
      },
      { property: "og:title", content: "Dzisiaj · Dziennik Jedzenia" },
      { property: "og:description", content: "Dzienny bilans kalorii, makroskładniki i posiłki." },
    ],
  }),
  component: Today,
});

function dateLabel(iso: string, today: string) {
  if (iso === today) return "Dzisiaj";
  if (iso === shiftDate(today, -1)) return "Wczoraj";
  return parseISO(iso).toLocaleDateString("pl-PL", { weekday: "long" });
}

function Today() {
  const today = warsawToday();
  const { selectedDate: storedDate, setSelectedDate: storeDate } = useNutrition();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const selectedDate = search.date ?? storedDate;
  useEffect(() => {
    if (search.date && search.date !== storedDate) storeDate(search.date);
  }, [search.date, storedDate, storeDate]);
  const setSelectedDate = (date: string) => {
    storeDate(date);
    void navigate({ search: { date }, replace: true });
  };
  const dayQuery = useQuery({
    queryKey: ["day", selectedDate],
    queryFn: () => getDay(selectedDate),
    retry: false,
  });
  const day = dayQuery.data;
  const totals = day?.totals;
  const goal = day?.goals;
  const longDate = parseISO(selectedDate).toLocaleDateString("pl-PL", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div className="animate-rise">
      <header className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-2.5 lg:hidden">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Leaf className="h-5 w-5" />
          </span>
          <span className="font-display text-lg font-semibold">Dziennik Jedzenia</span>
        </div>
        <Link
          to="/skanuj"
          aria-label="Skanuj etykietę"
          className="grid h-10 w-10 place-items-center rounded-xl border bg-card text-primary shadow-card lg:hidden"
        >
          <ScanLine className="h-5 w-5" />
        </Link>
      </header>

      <div className="mb-5 flex items-center justify-between rounded-2xl border bg-card p-1.5 shadow-card">
        <button
          aria-label="Poprzedni dzień"
          onClick={() => setSelectedDate(shiftDate(selectedDate, -1))}
          className="grid h-10 w-10 place-items-center rounded-xl hover:bg-muted"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <label className="relative flex cursor-pointer flex-col items-center">
          <span className="text-sm font-bold capitalize">{dateLabel(selectedDate, today)}</span>
          <span className="text-xs text-muted-foreground">{longDate}</span>
          <input
            type="date"
            aria-label="Wybierz dzień"
            value={selectedDate}
            max={today}
            onChange={(event) => event.target.value && setSelectedDate(event.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
        <button
          aria-label="Następny dzień"
          disabled={selectedDate >= today}
          onClick={() => setSelectedDate(shiftDate(selectedDate, 1))}
          className="grid h-10 w-10 place-items-center rounded-xl hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      {dayQuery.isPending ? (
        <Card className="p-6 text-center text-sm text-muted-foreground" role="status">
          Wczytuję dziennik…
        </Card>
      ) : dayQuery.isError && !day ? (
        <Card className="space-y-3 p-6 text-center" role="alert">
          <p className="font-semibold">Nie udało się wczytać dziennika.</p>
          <Btn variant="outline" onClick={() => void dayQuery.refetch()}>
            Spróbuj ponownie
          </Btn>
        </Card>
      ) : day && totals ? (
        <>
          {dayQuery.isError && (
            <Card role="alert" className="mb-4 p-4">
              <p>Nie udało się odświeżyć dnia. Widoczne dane mogą być nieaktualne.</p>
              <Btn variant="outline" onClick={() => void dayQuery.refetch()}>
                Odśwież dzień
              </Btn>
            </Card>
          )}
          <DaySummary day={day} />
          <MealCards day={day} />
        </>
      ) : null}
    </div>
  );
}
