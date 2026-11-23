import { useFrozenMutation } from "@/lib/api/use-frozen-mutation";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Target } from "lucide-react";
import { lazy, Suspense, useRef, useState, type FormEvent } from "react";
import { Btn, Card, Field, PageHeader } from "@/components/app/ui";
import { getGoals, saveGoals, type GoalsInput, type GoalViewDto } from "@/lib/api/goals";
import { ApiRequestError } from "@/lib/api/client";
import { positiveFormDecimalTextSchema } from "@/lib/contracts/decimal";
import { discardPrivateDraft, useAuth, usePrivateDraft } from "@/lib/auth/context";
const ProfileStatistics = lazy(() => import("@/components/app/statistics/ProfileStatistics"));
export const Route = createFileRoute("/profil")({
  head: () => ({
    meta: [
      { title: "Profil i cele · Dziennik Jedzenia" },
      {
        name: "description",
        content: "Ustaw własne dzienne cele kalorii, białka, tłuszczów i węglowodanów.",
      },
    ],
  }),
  component: Profile,
});
const FIELDS = [
  { key: "kcal_goal", label: "Kalorie", suffix: "kcal" },
  { key: "protein_goal", label: "Białko", suffix: "g" },
  { key: "fat_goal", label: "Tłuszcze", suffix: "g" },
  { key: "carbs_goal", label: "Węglowodany", suffix: "g" },
] as const;
type GoalKey = (typeof FIELDS)[number]["key"];
interface GoalDraft {
  id: string;
  expectedDate: string;
  revision: number;
  values: Record<GoalKey, string>;
}
function draftFrom(view: GoalViewDto): GoalDraft {
  return {
    id: view.today_id ?? crypto.randomUUID(),
    expectedDate: view.date,
    revision: view.today_revision,
    values: {
      kcal_goal: view.current?.kcal_goal ?? "",
      protein_goal: view.current?.protein_goal ?? "",
      fat_goal: view.current?.fat_goal ?? "",
      carbs_goal: view.current?.carbs_goal ?? "",
    },
  };
}
function Profile() {
  const { manager, snapshot } = useAuth();
  const goals = useQuery({ queryKey: ["goals"], queryFn: getGoals, retry: false });
  return (
    <div className="animate-rise mx-auto max-w-2xl">
      <PageHeader title="Profil" subtitle="Twoje cele i statystyki" />
      <Card className="min-h-[360px] p-5">
        <div className="mb-4 flex items-center gap-2">
          <Target className="h-5 w-5 text-primary" />
          <h2 className="font-bold">Dzienne cele</h2>
        </div>
        {goals.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Wczytuję cele…
          </p>
        ) : goals.isError ? (
          <div role="alert" className="space-y-3">
            <p>Nie udało się wczytać celów.</p>
            <Btn variant="outline" onClick={() => void goals.refetch()}>
              Spróbuj ponownie
            </Btn>
          </div>
        ) : goals.data ? (
          <GoalsForm view={goals.data} />
        ) : null}
      </Card>
      {snapshot.session && (
        <Suspense
          fallback={
            <Card className="mt-4 min-h-[680px] p-5">
              <p role="status">Wczytuję statystyki…</p>
            </Card>
          }
        >
          <ProfileStatistics ownerId={snapshot.session.owner_id} />
        </Suspense>
      )}
      <Card className="mt-4 p-5">
        <div className="mb-2 flex items-center gap-2">
          <LogOut className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-bold">Sesja</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Wylogowanie czyści prywatny stan tej aplikacji na bieżącym urządzeniu.
        </p>
        <Btn
          type="button"
          variant="outline"
          size="lg"
          className="w-full"
          onClick={() => void manager.logout()}
        >
          Wyloguj
        </Btn>
      </Card>
    </div>
  );
}
function GoalsForm({ view }: { view: GoalViewDto }) {
  const client = useQueryClient();
  const form = useRef<HTMLFormElement>(null);
  const active = useRef(false);
  const [draft, setDraft] = usePrivateDraft<GoalDraft>("today-goals", draftFrom(view));
  const [errors, setErrors] = useState<Partial<Record<GoalKey, string>>>({});
  const [status, setStatus] = useState("");
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);
  const mutation = useFrozenMutation<{ input: GoalsInput; revision: number }>("today-goals");
  const [committed, setCommitted] = useState(false);
  async function reload() {
    setSaving(true);
    try {
      const fresh = await getGoals();
      setDraft(draftFrom(fresh));
      client.setQueryData(["goals"], fresh);
      setErrors({});
      setCode("");
      setStatus("");
      mutation.reset();
      setCommitted(false);
    } catch {
      setStatus("Nie udało się wczytać dzisiejszych celów.");
    } finally {
      setSaving(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (active.current) return;
    const nextErrors: Partial<Record<GoalKey, string>> = {};
    const values = {} as Record<GoalKey, string>;
    for (const field of FIELDS) {
      const parsed = positiveFormDecimalTextSchema.safeParse(draft.values[field.key]);
      if (!parsed.success)
        nextErrors[field.key] =
          parsed.error.issues[0]?.message ?? "Wpisz poprawną liczbę większą od 0";
      else values[field.key] = parsed.data;
    }
    setErrors(nextErrors);
    setStatus("");
    setCode("");
    if (Object.keys(nextErrors).length) {
      requestAnimationFrame(() =>
        form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    const input: GoalsInput = { id: draft.id, expected_date: draft.expectedDate, ...values };
    active.current = true;
    setSaving(true);
    let saved = committed;
    try {
      if (!saved) {
        await mutation.run({ input, revision: draft.revision }, (command, key) =>
          saveGoals(command.input, command.revision, key),
        );
        saved = true;
        setCommitted(true);
        discardPrivateDraft("today-goals");
      }
      const fresh = await getGoals();
      setDraft(draftFrom(fresh));
      client.setQueryData(["goals"], fresh);
      await client.invalidateQueries({ queryKey: ["day"] });
      mutation.reset();
      setCommitted(false);
      setStatus("Zapisano");
    } catch (e) {
      setCode(saved ? "REFRESH_FAILED" : e instanceof ApiRequestError ? e.code : "NETWORK_ERROR");
      setStatus(
        saved
          ? "Zapisano cele, lecz nie udało się odświeżyć widoku. Wczytaj aktualne cele."
          : e instanceof ApiRequestError
            ? e.message
            : "Nie udało się potwierdzić zapisu. Ponów.",
      );
    } finally {
      active.current = false;
      setSaving(false);
    }
  }
  return (
    <form ref={form} onSubmit={(event) => void submit(event)} noValidate className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {FIELDS.map((field) => (
          <Field
            key={field.key}
            label={field.label}
            suffix={field.suffix}
            inputMode="decimal"
            value={draft.values[field.key]}
            error={errors[field.key]}
            disabled={saving || mutation.frozen || committed}
            onChange={(e) => {
              setDraft((d) => ({ ...d, values: { ...d.values, [field.key]: e.target.value } }));
              setStatus("");
            }}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Wpisz własne cele. Zmiana dotyczy dzisiejszego dnia i kolejnych dni bez nowej wersji.
      </p>
      {mutation.frozen && (
        <p role="status">Zapis niepotwierdzony. Ponowienie wyśle pierwotne wartości.</p>
      )}
      {status && (
        <p
          role={code ? "alert" : "status"}
          aria-live="polite"
          className={code ? "text-sm text-destructive-strong" : "text-sm text-primary"}
        >
          {status}
        </p>
      )}
      {code && !mutation.frozen && (
        <Btn type="button" variant="outline" disabled={saving} onClick={() => void reload()}>
          {code === "DAY_CHANGED" ? "Wczytaj dzisiejsze cele" : "Wczytaj aktualne cele"}
        </Btn>
      )}
      <Btn type="submit" size="lg" className="w-full" disabled={saving}>
        {saving ? "Zapisuję cele…" : committed ? "Ponów odczyt" : "Zapisz cele"}
      </Btn>
    </form>
  );
}
