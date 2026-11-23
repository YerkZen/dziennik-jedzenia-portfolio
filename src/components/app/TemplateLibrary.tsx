import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { Btn, Field, Sheet } from "./ui";
import { useFrozenMutation } from "@/lib/api/use-frozen-mutation";
import { ApiRequestError } from "@/lib/api/client";
import { listProducts, type ProductDto } from "@/lib/api/products";
import {
  archiveTemplate,
  getTemplate,
  listTemplates,
  saveTemplate,
  type TemplateDto,
  type TemplateInput,
} from "@/lib/api/templates";
import { positiveFormDecimalTextSchema } from "@/lib/contracts/decimal";
import { discardPrivateDraft, usePrivateDraft } from "@/lib/auth/context";

type Row = { item_id: string; product: ProductDto; quantity: string };

export function TemplateLibrary({
  onUse,
  onBusyChange,
}: {
  onUse: (template: TemplateDto) => void;
  onBusyChange?: ((busy: boolean) => void) | undefined;
}) {
  const client = useQueryClient();
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const templates = useQuery({
    queryKey: ["templates", query, offset],
    queryFn: () => listTemplates(query, offset),
    retry: false,
  });
  const [editor, setEditor] = useState<{ id: string; initial: TemplateDto | null } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const archiveKeys = useRef(new Map<string, string>());
  async function action(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    try {
      await operation();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Nie udało się wczytać zestawu.");
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  return (
    <section aria-label="Zapisane zestawy">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold">
          <Layers className="h-4 w-4 text-primary" /> Zapisane zestawy
        </h2>
        <Btn
          type="button"
          size="sm"
          variant="soft"
          onClick={() => setEditor({ id: crypto.randomUUID(), initial: null })}
        >
          <Plus className="h-4 w-4" /> Nowy zestaw
        </Btn>
      </div>
      <Field
        label="Szukaj zestawu"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOffset(0);
        }}
      />
      {templates.isPending && (
        <p role="status" className="mt-2 text-sm">
          Wczytuję zestawy…
        </p>
      )}
      {templates.isError && (
        <p role="alert" className="mt-2 text-sm text-destructive-strong">
          Nie udało się wczytać zestawów.{" "}
          <Btn type="button" variant="outline" size="sm" onClick={() => void templates.refetch()}>
            Ponów
          </Btn>
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive-strong">
          {error}
        </p>
      )}
      <div className="mt-3 grid gap-2">
        {templates.data?.items.map((template) => (
          <div key={template.id} className="card-surface flex min-w-0 items-center gap-1 p-2">
            <button
              aria-label={template.name}
              disabled={busy}
              className="min-h-11 min-w-0 flex-1 rounded-xl p-2 text-left focus-visible:ring-2"
              onClick={() => void action(async () => onUse(await getTemplate(template.id)))}
            >
              <span className="block break-words text-sm font-semibold">{template.name}</span>
              <span className="text-xs text-muted-foreground">
                {template.items.length} składników
              </span>
            </button>
            <Btn
              size="sm"
              variant="ghost"
              aria-label={`Edytuj zestaw: ${template.name}`}
              disabled={busy}
              onClick={() =>
                void action(async () =>
                  setEditor({ id: template.id, initial: await getTemplate(template.id) }),
                )
              }
            >
              <Pencil className="h-4 w-4" />
            </Btn>
            <Btn
              size="sm"
              variant="danger"
              aria-label={`Archiwizuj zestaw: ${template.name}`}
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const command = `${template.id}:${template.revision}`;
                  const key = archiveKeys.current.get(command) ?? crypto.randomUUID();
                  archiveKeys.current.set(command, key);
                  await archiveTemplate(template.id, template.revision, key);
                  archiveKeys.current.delete(command);
                  await client.invalidateQueries(
                    { queryKey: ["templates"] },
                    { throwOnError: true },
                  );
                })
              }
            >
              <Trash2 className="h-4 w-4" />
            </Btn>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        {offset > 0 && (
          <Btn variant="ghost" size="sm" onClick={() => setOffset(Math.max(0, offset - 100))}>
            Poprzednie zestawy
          </Btn>
        )}
        {templates.data?.has_more && (
          <Btn variant="ghost" size="sm" onClick={() => setOffset(offset + 100)}>
            Następne zestawy
          </Btn>
        )}
      </div>
      <Sheet
        open={editor !== null}
        title={editor?.initial ? "Edytuj zestaw" : "Nowy zestaw"}
        onClose={() => setEditor(null)}
      >
        {editor && (
          <TemplateEditor
            key={`${editor.id}:${editor.initial?.revision ?? 0}`}
            id={editor.id}
            initial={editor.initial}
            onClose={() => setEditor(null)}
            onSaved={async () => {
              await client.invalidateQueries({ queryKey: ["templates"] }, { throwOnError: true });
              setEditor(null);
            }}
          />
        )}
      </Sheet>
    </section>
  );
}

function TemplateEditor({
  id,
  initial,
  onClose,
  onSaved,
}: {
  id: string;
  initial: TemplateDto | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const draftKey = initial ? `template:${id}:${initial.revision}` : "template:new";
  const [draft, setDraft] = usePrivateDraft<{ name: string; rows: Row[] }>(draftKey, {
    name: initial?.name ?? "",
    rows:
      initial?.items.map((i) => ({
        item_id: i.item_id,
        product: i.product,
        quantity: i.quantity,
      })) ?? [],
  });
  const [q, setQ] = useState("");
  const products = useQuery({
    queryKey: ["products", q.trim()],
    queryFn: () => listProducts(q.trim()),
    retry: false,
    enabled: q.trim().length > 0,
  });
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const mutation = useFrozenMutation<{ id: string; revision: number | null; input: TemplateInput }>(
    draftKey,
  );
  const [committed, setCommitted] = useState(false);
  const [conflict, setConflict] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const invalidRows = draft.rows.some(
    (r) =>
      !positiveFormDecimalTextSchema.safeParse(r.quantity).success ||
      r.product.archived_at !== null,
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (
      !mutation.frozen &&
      !committed &&
      (!draft.name.trim() || draft.name.trim().length > 160 || !draft.rows.length || invalidRows)
    ) {
      setStatus("Sprawdź nazwę i składniki zestawu.");
      form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    const input: TemplateInput = mutation.command?.input ?? {
      name: draft.name.trim(),
      items: draft.rows.map((row) => ({
        item_id: row.item_id,
        product_id: row.product.id,
        expected_product_revision: row.product.revision,
        quantity: positiveFormDecimalTextSchema.parse(row.quantity),
      })),
    };
    setSaving(true);
    setStatus("");
    let saved = committed;
    try {
      if (!saved) {
        await mutation.run({ id, revision: initial?.revision ?? null, input }, (command, key) =>
          saveTemplate(command.id, command.revision, command.input, key),
        );
        saved = true;
        setCommitted(true);
        discardPrivateDraft(draftKey);
      }
      await onSaved();
    } catch (e) {
      setConflict(e instanceof ApiRequestError && e.status === 409);
      setStatus(
        saved
          ? "Zapisano zestaw, lecz nie udało się odświeżyć listy. Ponów odczyt."
          : e instanceof ApiRequestError
            ? e.message
            : "Nie udało się potwierdzić zapisu zestawu. Ponów.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <form ref={form} onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
      <fieldset className="space-y-4" disabled={saving || mutation.frozen || committed}>
        <Field
          label="Nazwa zestawu"
          autoFocus
          value={draft.name}
          maxLength={160}
          aria-invalid={!draft.name.trim()}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        />
        <Field label="Szukaj produktu" value={q} onChange={(e) => setQ(e.target.value)} />
        {q.trim() && (
          <div className="max-h-48 overflow-y-auto rounded-xl border">
            {products.isPending && (
              <p role="status" className="p-3 text-sm">
                Wyszukuję produkty…
              </p>
            )}
            {products.isError && (
              <p role="alert" className="p-3 text-sm">
                Nie udało się wczytać produktów.
              </p>
            )}
            {products.data?.items.map((product) => (
              <button
                type="button"
                key={product.id}
                aria-label={product.name}
                className="block min-h-11 w-full break-words p-3 text-left text-sm hover:bg-muted"
                onClick={() => {
                  setDraft((d) => ({
                    ...d,
                    rows: [...d.rows, { item_id: crypto.randomUUID(), product, quantity: "100" }],
                  }));
                  setQ("");
                }}
              >
                {product.name}
              </button>
            ))}
          </div>
        )}
        {!draft.rows.length && (
          <p role="alert" className="text-sm text-destructive-strong">
            Dodaj co najmniej jeden składnik.
          </p>
        )}
        {draft.rows.map((row) => (
          <div
            key={row.item_id}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-xl bg-muted/60 p-3"
          >
            <div className="col-span-2 min-w-0 break-words text-sm font-medium">
              {row.product.name}
            </div>
            <Field
              label={`Ilość: ${row.product.name}`}
              suffix={row.product.basis_unit}
              inputMode="decimal"
              value={row.quantity}
              error={
                row.product.archived_at
                  ? "Zastąp zarchiwizowany składnik."
                  : !positiveFormDecimalTextSchema.safeParse(row.quantity).success
                    ? "Podaj ilość większą od zera."
                    : undefined
              }
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
              size="sm"
              variant="danger"
              aria-label={`Usuń składnik: ${row.product.name}`}
              onClick={() =>
                setDraft((d) => ({ ...d, rows: d.rows.filter((r) => r.item_id !== row.item_id) }))
              }
            >
              <Trash2 className="h-4 w-4" />
            </Btn>
          </div>
        ))}
      </fieldset>
      {conflict && (
        <Btn variant="outline" onClick={onClose}>
          Wróć do listy i wczytaj aktualny zestaw
        </Btn>
      )}
      {mutation.frozen && (
        <p role="status">Zapis niepotwierdzony. Ponowienie wyśle pierwotne wartości.</p>
      )}
      {status && (
        <p role="alert" className="text-sm text-destructive-strong">
          {status}
        </p>
      )}
      {saving && (
        <p role="status" aria-live="polite">
          Zapisuję zestaw…
        </p>
      )}
      <div className="flex gap-2">
        <Btn type="button" variant="outline" onClick={onClose}>
          Anuluj
        </Btn>
        <Btn
          type="submit"
          className="flex-1"
          disabled={
            saving || (!mutation.frozen && !committed && (!draft.rows.length || invalidRows))
          }
        >
          Zapisz zestaw
        </Btn>
      </div>
    </form>
  );
}
