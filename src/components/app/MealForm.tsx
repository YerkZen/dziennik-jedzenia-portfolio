import { useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Plus, Search, Trash2 } from "lucide-react";
import { Btn, Card, Field } from "./ui";
import { TemplateLibrary } from "./TemplateLibrary";
import { NutrientSummary } from "./nutrition-ui";
import { useFrozenMutation } from "@/lib/api/use-frozen-mutation";
import { ApiRequestError } from "@/lib/api/client";
import { listProducts, type ProductDto } from "@/lib/api/products";
import type { DayMealDto } from "@/lib/api/day";
import { saveMeal, type MealInput } from "@/lib/api/meals";
import { getTemplate, type TemplateDto } from "@/lib/api/templates";
import { discardPrivateDraft, usePrivateDraft } from "@/lib/auth/context";
import {
  diaryDateSchema,
  nameSchema,
  positiveFormDecimalTextSchema,
  warsawToday,
} from "@/lib/contracts/decimal";
import { MEALS, type MealType } from "@/lib/nutrition/types";
import { portionExact, sumExact, toDisplayNutrients } from "@/lib/nutrition/decimal";
import { cn } from "@/lib/utils";

type Row = { kind: "new" | "existing"; item_id: string; product: ProductDto; quantity: string };
interface Draft {
  source_template?: { id: string; revision: number };
  sourceHasArchived?: boolean;
  id: string;
  name: string;
  date: string;
  category: MealType;
  rows: Row[];
}
function initialRows(meal: DayMealDto | undefined): Row[] {
  return (
    meal?.items.map((i) => ({
      kind: "existing",
      item_id: i.item_id,
      quantity: i.quantity,
      product: {
        id: i.product_id,
        name: i.product_name,
        basis_unit: i.basis_unit,
        revision: i.source_product_revision,
        kcal_per_100: i.kcal_per_100,
        protein_per_100: i.protein_per_100,
        fat_per_100: i.fat_per_100,
        carbs_per_100: i.carbs_per_100,
        archived_at: null,
        created_at: "",
        updated_at: "",
      },
    })) ?? []
  );
}
export function MealForm({
  initial,
  date,
  category = "breakfast",
  onSaved,
  onCancel,
}: {
  initial?: DayMealDto | undefined;
  date: string;
  category?: MealType | undefined;
  onSaved: (date: string) => void | Promise<void>;
  onCancel?: (() => void) | undefined;
}) {
  const draftKey = initial ? `meal:${initial.id}:${initial.revision}` : "meal:new";
  const [draft, setDraft] = usePrivateDraft<Draft>(draftKey, {
    id: initial?.id ?? crypto.randomUUID(),
    name: initial?.name ?? "",
    date: initial?.entry_date ?? date,
    category: initial?.category ?? category,
    rows: initialRows(initial),
  });
  const [q, setQ] = useState("");
  const [choosingTemplate, setChoosingTemplate] = useState(false);
  const products = useQuery({
    queryKey: ["products", q.trim()],
    queryFn: () => listProducts(q.trim()),
    enabled: q.trim().length > 0,
    retry: false,
  });
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [validate, setValidate] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const active = useRef(false);
  const mutation = useFrozenMutation<{ id: string; revision: number | null; input: MealInput }>(
    draftKey,
  );
  const [code, setCode] = useState("");
  const [committedDate, setCommittedDate] = useState<string | null>(null);
  const nameValid = nameSchema.safeParse(draft.name).success;
  const dateValid = diaryDateSchema.safeParse(draft.date).success;
  const valid =
    !draft.sourceHasArchived &&
    nameValid &&
    dateValid &&
    draft.rows.length > 0 &&
    draft.rows.every((row) => positiveFormDecimalTextSchema.safeParse(row.quantity).success);
  const total = toDisplayNutrients(
    sumExact(
      draft.rows.map((row) => {
        const parsed = positiveFormDecimalTextSchema.safeParse(row.quantity);
        return portionExact(
          {
            kcal: row.product.kcal_per_100,
            protein: row.product.protein_per_100,
            fat: row.product.fat_per_100,
            carbs: row.product.carbs_per_100,
          },
          parsed.success ? parsed.data : "0",
        );
      }),
    ),
  );
  function useTemplate(template: TemplateDto): void {
    setDraft((d) => ({
      ...d,
      name: d.name || template.name,
      source_template: { id: template.id, revision: template.revision },
      sourceHasArchived:
        template.archived_at !== null ||
        template.items.some((row) => row.product.archived_at !== null),
      rows: template.items.map((row) => ({
        kind: "new",
        item_id: crypto.randomUUID(),
        product: row.product,
        quantity: String(Number(row.quantity)),
      })),
    }));
    setStatus("");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (active.current) return;
    if (!valid && !mutation.frozen && committedDate === null) {
      setValidate(true);
      setStatus("Sprawdź nazwę, datę i ilości składników.");
      requestAnimationFrame(() =>
        form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    const input: MealInput = mutation.command?.input ?? {
      ...(!initial && draft.source_template ? { source_template: draft.source_template } : {}),
      name: draft.name.trim(),
      entry_date: draft.date,
      category: draft.category,
      items: draft.rows.map((row) =>
        row.kind === "existing"
          ? {
              kind: "existing",
              item_id: row.item_id,
              quantity: positiveFormDecimalTextSchema.parse(row.quantity),
            }
          : {
              kind: "new",
              item_id: row.item_id,
              product_id: row.product.id,
              expected_product_revision: row.product.revision,
              quantity: positiveFormDecimalTextSchema.parse(row.quantity),
            },
      ),
    };
    active.current = true;
    setSaving(true);
    setStatus("");
    setCode("");
    let committed = committedDate;
    try {
      if (!committed) {
        const result = await mutation.run(
          { id: draft.id, revision: initial?.revision ?? null, input },
          (command, key) => saveMeal(command.id, command.revision, command.input, key),
        );
        if (result.ack.deleted)
          throw new ApiRequestError(
            "Posiłek został usunięty. Wczytaj aktualny dzień.",
            409,
            "RESOURCE_DELETED",
          );
        committed = result.input.input.entry_date;
        setCommittedDate(committed);
        discardPrivateDraft(draftKey);
      }
      await onSaved(committed);
    } catch (e) {
      setCode(
        committed ? "REFRESH_FAILED" : e instanceof ApiRequestError ? e.code : "NETWORK_ERROR",
      );
      setStatus(
        committed
          ? "Zapisano posiłek, lecz nie udało się odświeżyć widoku. Ponów odczyt."
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
    <form ref={form} onSubmit={(event) => void submit(event)} noValidate className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Nazwa posiłku"
          disabled={choosingTemplate || saving || mutation.frozen || committedDate !== null}
          value={draft.name}
          maxLength={160}
          error={validate && !nameValid ? "Podaj nazwę posiłku." : undefined}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        />
        <Field
          label="Data posiłku"
          type="date"
          disabled={saving || mutation.frozen || committedDate !== null}
          value={draft.date}
          max={warsawToday()}
          error={validate && !dateValid ? "Wybierz dzisiejszą lub wcześniejszą datę." : undefined}
          onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
        />
      </div>
      <div
        className="grid grid-cols-4 gap-1.5 rounded-2xl border bg-card p-1.5 shadow-card"
        role="radiogroup"
        aria-label="Kategoria posiłku"
      >
        {MEALS.map((meal) => (
          <button
            type="button"
            key={meal.id}
            disabled={saving || mutation.frozen || committedDate !== null}
            role="radio"
            aria-checked={draft.category === meal.id}
            onClick={() => setDraft((d) => ({ ...d, category: meal.id }))}
            className={cn(
              "min-h-11 rounded-xl px-1 py-2.5 text-xs font-semibold focus-visible:ring-2 sm:text-sm",
              draft.category === meal.id
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {meal.label}
          </button>
        ))}
      </div>
      <div className={cn("grid gap-5", !initial && "lg:grid-cols-2 lg:items-start")}>
        <div className="space-y-5">
          <div>
            <Field
              disabled={saving || mutation.frozen || committedDate !== null}
              label="Szukaj produktu"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {q.trim() && (
              <Card className="mt-2 overflow-hidden">
                {products.isPending && (
                  <p role="status" className="p-4 text-sm">
                    Wyszukuję produkty…
                  </p>
                )}
                {products.isError && (
                  <p role="alert" className="p-4 text-sm text-destructive-strong">
                    Nie udało się wczytać produktów.
                  </p>
                )}
                {products.data?.items.length === 0 && (
                  <p className="p-4 text-sm text-muted-foreground">
                    Brak wyników. Dodaj produkt w zakładce Produkty.
                  </p>
                )}
                {products.data?.items.map((product) => (
                  <button
                    type="button"
                    disabled={saving || mutation.frozen || committedDate !== null}
                    key={product.id}
                    aria-label={product.name}
                    className="flex min-h-11 w-full items-center justify-between gap-2 border-b p-3 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      setDraft((d) => ({
                        ...d,
                        rows: [
                          ...d.rows,
                          { kind: "new", item_id: crypto.randomUUID(), product, quantity: "100" },
                        ],
                      }));
                      setQ("");
                    }}
                  >
                    <span className="min-w-0 break-words">{product.name}</span>
                    <Plus className="h-4 w-4 shrink-0 text-primary" />
                  </button>
                ))}
              </Card>
            )}
          </div>
          {!initial && (
            <fieldset disabled={saving || mutation.frozen || committedDate !== null}>
              <TemplateLibrary onUse={useTemplate} onBusyChange={setChoosingTemplate} />
            </fieldset>
          )}
        </div>
        <Card className="min-w-0 p-4">
          <h2 className="mb-3 text-sm font-bold">Twój posiłek</h2>
          {!draft.rows.length && (
            <p className="mb-4 text-sm text-muted-foreground">Dodaj co najmniej jeden składnik.</p>
          )}
          <div className="space-y-3">
            {draft.rows.map((row) => {
              const error = positiveFormDecimalTextSchema.safeParse(row.quantity).success
                ? undefined
                : `Ilość musi być większa od 0 ${row.product.basis_unit}.`;
              return (
                <div
                  key={row.item_id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 rounded-xl bg-muted/60 p-3"
                >
                  <div className="col-span-2 min-w-0 break-words text-sm font-medium">
                    {row.product.name}
                    {row.kind === "existing" && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        zapisane wartości
                      </span>
                    )}
                  </div>
                  <Field
                    label={`Ilość: ${row.product.name}`}
                    disabled={saving || mutation.frozen || committedDate !== null}
                    value={row.quantity}
                    inputMode="decimal"
                    suffix={row.product.basis_unit}
                    error={error}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        rows: d.rows.map((r) =>
                          r.item_id === row.item_id ? { ...r, quantity: e.target.value } : r,
                        ),
                      }))
                    }
                  />
                  <Btn
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={saving || mutation.frozen || committedDate !== null}
                    aria-label={`Usuń składnik: ${row.product.name}`}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        rows: d.rows.filter((r) => r.item_id !== row.item_id),
                      }))
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Btn>
                </div>
              );
            })}
          </div>
          <div className="mt-4">
            <p className="mb-2 text-xs text-muted-foreground">Podgląd przed zapisem</p>
            <NutrientSummary n={total} />
          </div>
          {draft.sourceHasArchived && (
            <p role="alert" className="mt-3 text-sm text-destructive-strong">
              Zastąp zarchiwizowany składnik w zestawie i wybierz go ponownie.
            </p>
          )}
          {draft.source_template && status && !mutation.frozen && !committedDate && (
            <Btn
              type="button"
              className="mt-3"
              variant="outline"
              onClick={() => {
                const sourceId = draft.source_template?.id;
                if (!sourceId) return;
                void getTemplate(sourceId)
                  .then(useTemplate)
                  .catch(() => setStatus("Nie udało się wczytać aktualnego zestawu."));
              }}
            >
              Wczytaj aktualny zestaw
            </Btn>
          )}
          {mutation.frozen && (
            <p role="status" className="mt-3 text-sm">
              Wynik zapisu niepotwierdzony. Ponowienie wyśle pierwotne wartości. Po potwierdzeniu
              możesz je edytować.
            </p>
          )}
          {code === "REVISION_CONFLICT" && initial && onCancel && (
            <Btn variant="outline" onClick={onCancel}>
              Wróć do dnia i wczytaj aktualny posiłek
            </Btn>
          )}
          {status && (
            <p role="alert" className="mt-3 text-sm text-destructive-strong">
              {status}
            </p>
          )}
          {saving && (
            <p role="status" aria-live="polite" className="mt-3 text-sm">
              Zapisuję posiłek…
            </p>
          )}
          <div className="mt-4 flex gap-2">
            {onCancel && (
              <Btn
                type="button"
                variant="outline"
                disabled={saving || mutation.frozen}
                onClick={onCancel}
              >
                Anuluj
              </Btn>
            )}
            <Btn
              type="submit"
              size="lg"
              className="min-w-0 flex-1"
              disabled={
                (!valid && !mutation.frozen && committedDate === null) || saving || choosingTemplate
              }
            >
              <Check className="h-5 w-5" /> {committedDate ? "Ponów odczyt" : "Zapisz posiłek"}
            </Btn>
          </div>
        </Card>
      </div>
    </form>
  );
}
