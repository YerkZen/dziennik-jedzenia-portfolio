import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Btn, Card, Field, PageHeader } from "@/components/app/ui";
import { DaySummary } from "@/components/app/DaySummary";
import { MealCards } from "@/components/app/MealCards";
import { getDay } from "@/lib/api/day";
import { diaryDateSchema, warsawToday } from "@/lib/contracts/decimal";
import { useNutrition } from "@/lib/nutrition/store";

export const Route = createFileRoute("/historia")({
  validateSearch: (input: Record<string, unknown>): { date?: string } =>
    diaryDateSchema.safeParse(input["date"]).success ? { date: input["date"] as string } : {},
  head: () => ({
    meta: [
      { title: "Historia · Dziennik Jedzenia" },
      { name: "description", content: "Historia posiłków i bilans wybranego dnia." },
    ],
  }),
  component: History,
});
function History() {
  const { selectedDate, setSelectedDate } = useNutrition();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const date = search.date ?? selectedDate;
  useEffect(() => {
    if (search.date && search.date !== selectedDate) setSelectedDate(search.date);
  }, [search.date, selectedDate, setSelectedDate]);
  const day = useQuery({ queryKey: ["day", date], queryFn: () => getDay(date), retry: false });
  return (
    <div className="animate-rise">
      <PageHeader title="Historia" subtitle="Wybrany dzień" />
      <Card className="mb-5 p-4">
        <Field
          label="Wybierz dzień"
          type="date"
          value={date}
          max={warsawToday()}
          onChange={(e) => {
            const parsed = diaryDateSchema.safeParse(e.target.value);
            if (parsed.success) {
              setSelectedDate(parsed.data);
              void navigate({ search: { date: parsed.data }, replace: true });
            }
          }}
        />
      </Card>
      {day.isPending ? (
        <Card role="status" className="p-6 text-sm text-muted-foreground">
          Wczytuję dziennik…
        </Card>
      ) : day.isError && !day.data ? (
        <Card role="alert" className="space-y-3 p-6">
          <p>Nie udało się wczytać dziennika.</p>
          <Btn variant="outline" onClick={() => void day.refetch()}>
            Spróbuj ponownie
          </Btn>
        </Card>
      ) : day.data ? (
        <>
          {day.isError && (
            <Card role="alert" className="mb-4 p-4">
              <p>Nie udało się odświeżyć historii. Widoczne dane mogą być nieaktualne.</p>
              <Btn variant="outline" onClick={() => void day.refetch()}>
                Odśwież dzień
              </Btn>
            </Card>
          )}
          <DaySummary day={day.data} />
          <MealCards day={day.data} />
        </>
      ) : null}
    </div>
  );
}
