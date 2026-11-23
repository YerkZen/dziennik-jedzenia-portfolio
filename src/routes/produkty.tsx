import { discardPrivateDraft } from "@/lib/auth/private-drafts";
import { useFrozenMutation } from "@/lib/api/use-frozen-mutation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Camera, PackageOpen, Pencil, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { MacroChips } from "@/components/app/nutrition-ui";
import { ProductForm, type ProductDraft } from "@/components/app/ProductForm";
import { Btn, Card, EmptyState, PageHeader, Sheet } from "@/components/app/ui";
import {
  archiveProduct,
  createProduct,
  getProduct,
  listProducts,
  toNutritionProduct,
  updateProduct,
  type ProductCreateInput,
  type ProductDto,
} from "@/lib/api/products";
import { ApiRequestError } from "@/lib/api/client";
import { fmt } from "@/lib/nutrition/calc";

export const Route = createFileRoute("/produkty")({
  head: () => ({
    meta: [
      { title: "Produkty · Dziennik Jedzenia" },
      {
        name: "description",
        content: "Twoja własna baza produktów spożywczych z wartościami odżywczymi.",
      },
      { property: "og:title", content: "Produkty · Dziennik Jedzenia" },
      { property: "og:description", content: "Własna baza produktów spożywczych." },
    ],
  }),
  component: Products,
});

type ProductEditor = { kind: "create" } | { kind: "edit"; product: ProductDto };

function Products() {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<ProductEditor | null>(null);
  const [searchText, setSearchText] = useState("");
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const editDraftKey =
    editor?.kind === "edit"
      ? `product-form:edit:${editor.product.id}:${editor.product.revision}`
      : "product-form:new";
  const mutation = useFrozenMutation<{
    id: string;
    revision: number | null;
    payload: ProductCreateInput;
  }>(editDraftKey);
  const pendingArchive = useRef<{ fingerprint: string; key: string } | null>(null);
  const search = searchText.trim();
  const productsQuery = useQuery({
    queryKey: ["products", search],
    queryFn: () => listProducts(search),
    retry: false,
  });
  const products = productsQuery.data?.items ?? [];

  const submitProduct = async (draft: ProductDraft) => {
    const result = await mutation.run(
      {
        id: editor?.kind === "edit" ? editor.product.id : crypto.randomUUID(),
        revision: editor?.kind === "edit" ? editor.product.revision : null,
        payload: {
          id: editor?.kind === "edit" ? editor.product.id : crypto.randomUUID(),
          name: draft.name,
          basis_unit: draft.basisUnit,
          kcal_per_100: draft.kcal,
          protein_per_100: draft.protein,
          fat_per_100: draft.fat,
          carbs_per_100: draft.carbs,
        },
      },
      (command, key) => {
        if (command.revision === null)
          return createProduct({ ...command.payload, id: command.id }, key);
        const { id: _id, basis_unit: _unit, ...input } = command.payload;
        return updateProduct(command.id, command.revision, input, key);
      },
    );
    setStatusMessage("Produkt zapisany.");
    setEditor(null);
    try {
      await queryClient.invalidateQueries({ queryKey: ["products"] }, { throwOnError: true });
    } catch {
      setStatusMessage("Produkt zapisany. Nie udało się odświeżyć listy. Odśwież widok.");
    }
    void result;
  };

  const submitArchive = async (product: ProductDto) => {
    setArchiveError(null);
    setStatusMessage(null);
    const fingerprint = `${product.id}:${product.revision}`;
    if (!pendingArchive.current || pendingArchive.current.fingerprint !== fingerprint) {
      pendingArchive.current = { fingerprint, key: crypto.randomUUID() };
    }
    try {
      await archiveProduct(product.id, product.revision, pendingArchive.current.key);
      pendingArchive.current = null;
      setStatusMessage("Produkt zarchiwizowany.");
      await queryClient.invalidateQueries({ queryKey: ["products"] });
    } catch (error) {
      setArchiveError(
        error instanceof ApiRequestError
          ? error.message
          : "Nie udało się potwierdzić archiwizacji. Spróbuj ponownie.",
      );
    }
  };

  const editInitial = editor?.kind === "edit" ? editor.product : undefined;

  return (
    <div className="animate-rise">
      <PageHeader
        title="Produkty"
        subtitle={productsQuery.data ? `${products.length} w Twojej bazie` : "Twoja baza produktów"}
        right={
          <Btn onClick={() => setEditor({ kind: "create" })}>
            <Plus className="h-4 w-4" /> Nowy
          </Btn>
        }
      />

      <Card className="mb-4 space-y-3 p-4">
        <div>
          <h2 className="font-semibold">Produkt ze zdjęcia</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Wybierz zdjęcie etykiety z galerii lub użyj aparatu. Sprawdzisz kcal i makro przed
            zapisaniem produktu.
          </p>
        </div>
        <Link
          to="/skanuj"
          className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl bg-primary-soft px-4 py-2 text-sm font-semibold text-accent-foreground transition-colors hover:bg-primary-soft/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto"
        >
          <Camera className="h-4 w-4" aria-hidden="true" />
          Dodaj ze zdjęcia
        </Link>
      </Card>

      <label className="mb-4 flex h-12 items-center rounded-2xl border border-input bg-card px-4 shadow-card focus-within:border-primary">
        <input
          aria-label="Szukaj produktu"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder="Szukaj produktu…"
          className="w-full bg-transparent text-base outline-none placeholder:text-muted-foreground/70"
        />
      </label>

      {archiveError && (
        <Card className="mb-4 space-y-3 p-4" role="alert">
          <p className="text-sm">{archiveError}</p>
          <Btn
            variant="outline"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ["products"] })}
          >
            Odśwież listę
          </Btn>
        </Card>
      )}
      {statusMessage && (
        <p role="status" className="mb-3 text-sm text-muted-foreground" aria-live="polite">
          {statusMessage}
        </p>
      )}

      {productsQuery.isPending ? (
        <Card className="p-6 text-center text-sm text-muted-foreground" role="status">
          Wczytuję produkty…
        </Card>
      ) : productsQuery.isError ? (
        <Card className="space-y-3 p-6 text-center" role="alert">
          <p className="font-semibold">
            {productsQuery.error instanceof ApiRequestError
              ? productsQuery.error.message
              : "Nie udało się wczytać produktów."}
          </p>
          <Btn variant="outline" onClick={() => void productsQuery.refetch()}>
            Spróbuj ponownie
          </Btn>
        </Card>
      ) : products.length === 0 ? (
        <Card>
          <EmptyState
            icon={<PackageOpen className="h-6 w-6" />}
            title={search ? "Brak wyników" : "Baza jest pusta"}
            text={
              search
                ? "Spróbuj innej nazwy produktu."
                : "Dodaj pierwszy produkt ręcznie albo wybierz opcję „Dodaj ze zdjęcia” powyżej."
            }
            action={
              !search ? (
                <Btn variant="soft" onClick={() => setEditor({ kind: "create" })}>
                  <Plus className="h-4 w-4" /> Dodaj produkt
                </Btn>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y">
            {products.map((product) => {
              const nutritionProduct = toNutritionProduct(product);
              return (
                <li key={product.id}>
                  <div className="flex items-center gap-3 px-4 py-3.5 text-left">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{product.name}</p>
                      <MacroChips n={nutritionProduct} className="mt-1" />
                    </div>
                    <div className="text-right">
                      <p className="tabular font-semibold">{fmt(nutritionProduct.kcal)}</p>
                      <p className="text-[11px] text-muted-foreground">
                        kcal/100 {product.basis_unit}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Btn
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Edytuj ${product.name}`}
                        onClick={() => setEditor({ kind: "edit", product })}
                      >
                        <Pencil className="h-4 w-4" />
                      </Btn>
                      <Btn
                        type="button"
                        variant="danger"
                        size="sm"
                        aria-label={`Archiwizuj ${product.name}`}
                        onClick={() => void submitArchive(product)}
                      >
                        <Archive className="h-4 w-4" />
                      </Btn>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Sheet
        open={editor !== null}
        onClose={() => setEditor(null)}
        title={editor?.kind === "edit" ? "Edytuj produkt" : "Nowy produkt"}
      >
        {editor && (
          <ProductForm
            key={editDraftKey}
            initial={
              editInitial
                ? {
                    name: editInitial.name,
                    basisUnit: editInitial.basis_unit,
                    kcal: editInitial.kcal_per_100,
                    protein: editInitial.protein_per_100,
                    fat: editInitial.fat_per_100,
                    carbs: editInitial.carbs_per_100,
                  }
                : undefined
            }
            onReload={
              editor.kind === "edit"
                ? () => {
                    void getProduct(editor.product.id)
                      .then((product) => {
                        discardPrivateDraft(editDraftKey);
                        setEditor({ kind: "edit", product });
                      })
                      .catch(() => setArchiveError("Nie udało się wczytać aktualnego produktu."));
                  }
                : undefined
            }
            frozen={mutation.frozen}
            draftKey={editDraftKey}
            readOnlyBasisUnit={editor.kind === "edit"}
            submitLabel={editor.kind === "edit" ? "Zapisz zmiany" : "Zapisz produkt"}
            onCancel={() => setEditor(null)}
            onSubmit={submitProduct}
          />
        )}
      </Sheet>
    </div>
  );
}
