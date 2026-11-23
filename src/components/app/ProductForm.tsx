import { useState } from "react";
import { formDecimalTextSchema, nameSchema } from "@/lib/contracts/decimal";
import { discardPrivateDraft, usePrivateDraft } from "@/lib/auth/context";
import { Btn, Field } from "./ui";

export interface ProductDraft {
  name: string;
  basisUnit: "g" | "ml";
  kcal: string;
  protein: string;
  fat: string;
  carbs: string;
}

type DraftStrings = Omit<ProductDraft, "basisUnit"> & { basisUnit: "g" | "ml" | "" };
type ProductFormInitial = Partial<{
  name: string;
  basisUnit: "g" | "ml" | "";
  kcal: number | string;
  protein: number | string;
  fat: number | string;
  carbs: number | string;
}>;

type Errors = Partial<Record<keyof ProductDraft, string>>;

export function validateProduct(d: DraftStrings): { value?: ProductDraft; errors: Errors } {
  const errors: Errors = {};
  const parsedName = nameSchema.safeParse(d.name);
  if (!parsedName.success)
    errors.name = parsedName.error.issues[0]?.message ?? "Podaj nazwę produktu";
  if (d.basisUnit !== "g" && d.basisUnit !== "ml") errors.basisUnit = "Wybierz jednostkę produktu";

  const decimal = (key: "kcal" | "protein" | "fat" | "carbs"): string => {
    const parsed = formDecimalTextSchema.safeParse(d[key]);
    if (!parsed.success) {
      errors[key] = parsed.error.issues[0]?.message ?? "Niepoprawna wartość dziesiętna";
      return "0";
    }
    return parsed.data;
  };
  const value = {
    name: parsedName.success ? parsedName.data : d.name.trim(),
    basisUnit: d.basisUnit === "ml" ? ("ml" as const) : ("g" as const),
    kcal: decimal("kcal"),
    protein: decimal("protein"),
    fat: decimal("fat"),
    carbs: decimal("carbs"),
  };
  return Object.keys(errors).length ? { errors } : { value, errors };
}

export function ProductForm({
  initial,
  submitLabel = "Zapisz produkt",
  draftKey = "product-form",
  readOnlyBasisUnit = false,
  frozen = false,
  onReload,
  onSubmit,
  onCancel,
}: {
  initial?: ProductFormInitial | undefined;
  submitLabel?: string;
  draftKey?: string;
  readOnlyBasisUnit?: boolean;
  frozen?: boolean;
  onReload?: (() => void) | undefined;
  onSubmit: (p: ProductDraft) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [d, setD] = usePrivateDraft<DraftStrings>(draftKey, {
    name: initial?.name ?? "",
    basisUnit: initial?.basisUnit ?? "g",
    kcal: initial?.kcal?.toString() ?? "",
    protein: initial?.protein?.toString() ?? "",
    fat: initial?.fat?.toString() ?? "",
    carbs: initial?.carbs?.toString() ?? "",
  });
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const set = (k: keyof DraftStrings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setD((s) => ({ ...s, [k]: e.target.value }));

  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if (submitting) return;
        const r = validateProduct(d);
        setErrors(r.errors);
        if (!r.value) {
          const firstInvalidField = Object.keys(r.errors)[0];
          if (firstInvalidField) {
            e.currentTarget
              .querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${firstInvalidField}"]`)
              ?.focus();
          }
        }
        if (r.value) {
          setSubmitting(true);
          setSubmitError(null);
          try {
            await onSubmit(r.value);
            discardPrivateDraft(draftKey);
          } catch (error) {
            setSubmitError(
              error instanceof Error
                ? error.message
                : "Nie udało się potwierdzić zapisu. Spróbuj ponownie.",
            );
          } finally {
            setSubmitting(false);
          }
        }
      }}
      className="space-y-4"
    >
      <fieldset disabled={submitting || frozen} className="space-y-4">
        <Field
          label="Nazwa"
          name="name"
          value={d.name}
          onChange={set("name")}
          placeholder="np. Jogurt grecki"
          error={errors.name}
          autoFocus
        />
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Jednostka produktu
          </span>
          {readOnlyBasisUnit ? (
            <input
              aria-label="Jednostka produktu"
              readOnly
              value={d.basisUnit}
              className="h-12 w-full rounded-xl border border-input bg-muted px-3.5 text-base"
            />
          ) : (
            <select
              aria-label="Jednostka produktu"
              name="basisUnit"
              aria-invalid={Boolean(errors.basisUnit)}
              aria-describedby={errors.basisUnit ? "product-unit-error" : undefined}
              value={d.basisUnit}
              onChange={(event) =>
                setD((current) => ({
                  ...current,
                  basisUnit: event.target.value as "g" | "ml" | "",
                }))
              }
              className="h-12 w-full rounded-xl border border-input bg-card px-3.5 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Wybierz jednostkę</option>
              <option value="g">g</option>
              <option value="ml">ml</option>
            </select>
          )}
          {errors.basisUnit && (
            <span id="product-unit-error" className="text-xs text-destructive-strong">
              {errors.basisUnit}
            </span>
          )}
        </label>
        <p className="pt-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Wartości na 100 {d.basisUnit}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Energia"
            name="kcal"
            suffix="kcal"
            inputMode="decimal"
            value={d.kcal}
            onChange={set("kcal")}
            placeholder="0"
            error={errors.kcal}
          />
          <Field
            label="Białko"
            name="protein"
            suffix="g"
            inputMode="decimal"
            value={d.protein}
            onChange={set("protein")}
            placeholder="0"
            error={errors.protein}
          />
          <Field
            label="Tłuszcze"
            name="fat"
            suffix="g"
            inputMode="decimal"
            value={d.fat}
            onChange={set("fat")}
            placeholder="0"
            error={errors.fat}
          />
          <Field
            label="Węglowodany"
            name="carbs"
            suffix="g"
            inputMode="decimal"
            value={d.carbs}
            onChange={set("carbs")}
            placeholder="0"
            error={errors.carbs}
          />
        </div>
      </fieldset>
      {frozen && <p role="status">Zapis niepotwierdzony. Ponowienie wyśle pierwotne wartości.</p>}
      {submitError && onReload && !frozen && (
        <Btn variant="outline" onClick={onReload}>
          Wczytaj aktualny produkt
        </Btn>
      )}
      {submitError && (
        <p role="alert" className="text-sm text-destructive-strong">
          {submitError}
        </p>
      )}
      <div className="flex gap-2 pt-2">
        {onCancel && (
          <Btn
            type="button"
            variant="outline"
            className="flex-1"
            disabled={submitting || frozen}
            onClick={() => {
              discardPrivateDraft(draftKey);
              onCancel();
            }}
          >
            Anuluj
          </Btn>
        )}
        <Btn type="submit" className="flex-1" disabled={submitting}>
          {submitting ? "Zapisywanie…" : submitLabel}
        </Btn>
      </div>
    </form>
  );
}
