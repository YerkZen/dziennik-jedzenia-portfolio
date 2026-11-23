import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Btn, Field, Sheet } from "@/components/app/ui";
import { ApiRequestError } from "@/lib/api/client";
import {
  getStatistics,
  mutateWeight,
  statisticsDateLabel,
  type WeightCommand,
} from "@/lib/api/statistics";
import { useFrozenMutation } from "@/lib/api/use-frozen-mutation";
import { usePrivateDraft } from "@/lib/auth/context";
import {
  statisticsDateSchema,
  weightFormSchema,
  type StatisticsDay,
} from "@/lib/contracts/statistics";
import { formatNutritionValue } from "@/lib/nutrition/format";

interface Draft {
  date: string;
  weight: string;
  base: StatisticsDay | null;
  deleting: StatisticsDay | null;
}

export function WeightMeasurements({
  ownerId,
  today,
  days,
  available,
  rangeKey,
}: {
  ownerId: string;
  today: string;
  days: StatisticsDay[];
  available: boolean;
  rangeKey: string;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = usePrivateDraft<Draft>("weight-form", {
    date: today,
    weight: "",
    base: null,
    deleting: null,
  });
  const mutation = useFrozenMutation<WeightCommand>("weight-form");
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const [weightError, setWeightError] = useState("");
  const [message, setMessage] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(draft.deleting !== null);
  const weightField = useRef<HTMLDivElement>(null);
  const validDate = statisticsDateSchema.safeParse(draft.date).success;
  const editing = draft.base?.weight_kg != null;
  const frozen = mutation.frozen;
  const locked = busy || frozen;

  // A base revision belongs to the opened draft, never to a later background refresh.
  // A single-day read also resolves dates outside the displayed chart and tombstones.
  useEffect(() => {
    if (draft.base || !validDate) return;
    const controller = new AbortController();
    setLookupError("");
    void getStatistics({ from: draft.date, to: draft.date }, { signal: controller.signal }).then(
      (result) => {
        if (controller.signal.aborted) return;
        const base = result.days[0]!;
        setDraft((current) => ({
          ...current,
          base,
          weight: current.weight || base.weight_kg?.replace(".", ",") || "",
        }));
      },
      (reason: unknown) => {
        if (!controller.signal.aborted)
          setLookupError(reason instanceof Error ? reason.message : "Sprawdź połączenie.");
      },
    );
    return () => controller.abort();
  }, [draft.date, draft.base, validDate, lookupAttempt, setDraft]);

  function edit(day: StatisticsDay) {
    if (locked) return;
    setDraft({
      date: day.date,
      weight: day.weight_kg?.replace(".", ",") ?? "",
      base: day,
      deleting: null,
    });
    setError("");
    setWeightError("");
    setMessage("");
    weightField.current?.querySelector("input")?.focus();
  }
  function chooseDate(date: string) {
    setDraft({ date, weight: "", base: null, deleting: null });
    setLookupError("");
    setConflict(false);
    setError("");
    setWeightError("");
    setMessage("");
  }
  async function execute(command: WeightCommand) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await mutation.run(command, mutateWeight);
      const removed = result.input.kind === "delete";
      // ACK confirms the command, not a speculative local point. Always reread the series.
      await client.invalidateQueries(
        { queryKey: ["statistics", ownerId] },
        { cancelRefetch: false },
      );
      setDraft((current) => ({
        ...current,
        ...(current.date === result.input.date ? { base: null, weight: "" } : {}),
        deleting: null,
      }));
      setDeleteOpen(false);
      setMessage(
        `${removed ? "Usunięto" : "Zapisano"} pomiar z ${statisticsDateLabel(result.input.date)}.${
          !days.some((day) => day.date === result.input.date)
            ? " Data jest poza wyświetlanym okresem."
            : ""
        }`,
      );
    } catch (reason) {
      setConflict(reason instanceof ApiRequestError && [404, 409, 412].includes(reason.status));
      setError(reason instanceof Error ? reason.message : "Nie udało się potwierdzić zapisu.");
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (mutation.command) {
      void execute(mutation.command);
      return;
    }
    const parsed = weightFormSchema.safeParse(draft.weight);
    if (!parsed.success) {
      setWeightError(parsed.error.issues[0]?.message ?? "Sprawdź wagę.");
      weightField.current?.querySelector("input")?.focus();
      return;
    }
    if (!draft.base || !validDate) return;
    void execute({
      kind: "save",
      date: draft.date,
      revision: draft.base.weight_revision,
      weight: parsed.data,
    });
  }
  function closeDelete() {
    if (busy) return;
    setDeleteOpen(false);
    if (!mutation.frozen) {
      setDraft((current) => ({ ...current, deleting: null }));
      setError("");
    }
  }
  return (
    <div className="mb-6 space-y-4 border-t border-border pt-4">
      <h3 className="font-semibold">Pomiary wagi</h3>
      <form onSubmit={submit} noValidate className="space-y-3" aria-label="Pomiar wagi">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Data pomiaru"
            type="date"
            min="1900-01-01"
            max={today}
            value={draft.date}
            disabled={locked || editing}
            onChange={(event) => chooseDate(event.target.value)}
            error={!validDate ? "Wybierz datę od 01.01.1900 do dzisiaj." : undefined}
          />
          <div ref={weightField}>
            <Field
              label="Waga (kg)"
              inputMode="decimal"
              value={draft.weight}
              placeholder="np. 72,35"
              disabled={locked}
              error={weightError || undefined}
              onChange={(event) => {
                setDraft((current) => ({ ...current, weight: event.target.value }));
                setWeightError("");
                setMessage("");
              }}
            />
          </div>
        </div>
        {editing && (
          <p className="text-xs text-muted-foreground">
            Edytujesz pomiar z {statisticsDateLabel(draft.date)}. Aby zmienić datę, usuń pomiar i
            dodaj nowy.
          </p>
        )}
        {!draft.base && validDate && !lookupError && (
          <p role="status" className="text-sm text-muted-foreground">
            Sprawdzam pomiar dla wybranej daty…
          </p>
        )}
        {lookupError && (
          <div role="alert" className="space-y-2 text-sm text-destructive-strong">
            <p>Nie udało się sprawdzić pomiaru. {lookupError}</p>
            <Btn variant="outline" onClick={() => setLookupAttempt((value) => value + 1)}>
              Ponów odczyt pomiaru
            </Btn>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {mutation.command?.kind !== "delete" && (
            <Btn type="submit" disabled={busy || (!frozen && (!draft.base || !validDate))}>
              {busy
                ? "Zapisuję…"
                : frozen
                  ? "Ponów zapis"
                  : editing
                    ? "Zapisz zmiany"
                    : "Zapisz pomiar"}
            </Btn>
          )}
          <Btn variant="outline" disabled={locked} onClick={() => chooseDate("")}>
            Wybierz inny pomiar
          </Btn>
          {mutation.command?.kind === "delete" && (
            <Btn variant="outline" disabled={busy} onClick={() => setDeleteOpen(true)}>
              Wznów usuwanie
            </Btn>
          )}
        </div>
      </form>
      {conflict && !deleteOpen && (
        <Btn
          variant="outline"
          disabled={busy}
          onClick={() => {
            const date = draft.deleting?.date ?? draft.date;
            setDeleteOpen(false);
            chooseDate(date);
          }}
        >
          Wczytaj aktualny pomiar
        </Btn>
      )}
      {error && !deleteOpen && (
        <p role="alert" className="text-sm text-destructive-strong">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-primary">
          {message}
        </p>
      )}
      {available && (
        <WeightEntryList
          key={rangeKey}
          days={days}
          disabled={locked}
          onEdit={edit}
          onDelete={(day) => {
            setDraft((current) => ({ ...current, deleting: day }));
            setError("");
            setDeleteOpen(true);
          }}
        />
      )}
      <Sheet open={deleteOpen} onClose={closeDelete} title="Usunąć pomiar wagi?">
        <p className="mb-4 text-sm">
          Pomiar z {draft.deleting && statisticsDateLabel(draft.deleting.date)}:{" "}
          {draft.deleting?.weight_kg && formatNutritionValue(draft.deleting.weight_kg)} kg. Po
          potwierdzeniu zniknie z historii i wykresu.
        </p>
        {error && (
          <p role="alert" className="mb-3 text-sm text-destructive-strong">
            {error}
          </p>
        )}
        {conflict && (
          <Btn
            variant="outline"
            disabled={busy}
            onClick={() => {
              const date = draft.deleting?.date ?? draft.date;
              setDeleteOpen(false);
              chooseDate(date);
            }}
          >
            Wczytaj aktualny pomiar
          </Btn>
        )}
        <div className="flex flex-wrap gap-2">
          <Btn variant="outline" autoFocus disabled={busy} onClick={closeDelete}>
            Anuluj
          </Btn>
          <Btn
            variant="danger"
            disabled={busy}
            onClick={() => {
              const day = draft.deleting;
              if (mutation.command) void execute(mutation.command);
              else if (day)
                void execute({ kind: "delete", date: day.date, revision: day.weight_revision });
            }}
          >
            {busy ? "Usuwam…" : frozen ? "Ponów usunięcie" : "Usuń pomiar"}
          </Btn>
        </div>
      </Sheet>
    </div>
  );
}

function WeightEntryList({
  days,
  disabled,
  onEdit,
  onDelete,
}: {
  days: StatisticsDay[];
  disabled: boolean;
  onEdit: (day: StatisticsDay) => void;
  onDelete: (day: StatisticsDay) => void;
}) {
  const [page, setPage] = useState(0);
  const entries = days
    .filter((day) => day.weight_kg !== null)
    .slice()
    .reverse();
  const last = Math.max(0, Math.ceil(entries.length / 30) - 1);
  const current = Math.min(page, last);
  if (!entries.length) return null;
  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">
        Pomiary w wyświetlanym okresie, od najnowszego.
      </p>
      <ul aria-label="Pomiary wagi" className="divide-y divide-border">
        {entries.slice(current * 30, (current + 1) * 30).map((day) => (
          <li key={day.date} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="text-sm tabular-nums">
              {statisticsDateLabel(day.date)} ·{" "}
              <strong>{formatNutritionValue(day.weight_kg!)} kg</strong>
            </span>
            <div className="flex gap-1">
              <Btn
                size="sm"
                variant="outline"
                disabled={disabled}
                aria-label={`Edytuj pomiar ${statisticsDateLabel(day.date)}`}
                onClick={() => onEdit(day)}
              >
                Edytuj
              </Btn>
              <Btn
                size="sm"
                variant="danger"
                disabled={disabled}
                aria-label={`Usuń pomiar ${statisticsDateLabel(day.date)}`}
                onClick={() => onDelete(day)}
              >
                Usuń
              </Btn>
            </div>
          </li>
        ))}
      </ul>
      {last > 0 && (
        <nav aria-label="Strony pomiarów wagi" className="mt-3 flex flex-wrap items-center gap-2">
          <Btn
            variant="outline"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
            aria-label="Nowsze pomiary"
          >
            ←
          </Btn>
          <span className="text-xs" aria-live="polite">
            {current + 1} / {last + 1}
          </span>
          <Btn
            variant="outline"
            disabled={current === last}
            onClick={() => setPage(current + 1)}
            aria-label="Starsze pomiary"
          >
            →
          </Btn>
        </nav>
      )}
    </div>
  );
}
