import { useFrozenMutation } from "@/lib/api/use-frozen-mutation";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Camera, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Btn, Card, PageHeader } from "@/components/app/ui";
import { ProductForm, type ProductDraft } from "@/components/app/ProductForm";
import { discardPrivateDraft } from "@/lib/auth/context";
import { ApiRequestError } from "@/lib/api/client";
import { readLabelImage, type LabelProposal } from "@/lib/api/label-readings";
import { createProduct } from "@/lib/api/products";
import {
  LabelImagePreparationError,
  prepareLabelImage,
  type PreparedLabelImage,
} from "@/lib/label/image-preparation";
import { createPrivateObjectUrl, revokePrivateObjectUrl } from "@/lib/auth/private-object-urls";

export const Route = createFileRoute("/skanuj")({
  head: () => ({
    meta: [
      { title: "Skanuj etykietę · Dziennik Jedzenia" },
      {
        name: "description",
        content: "Odczytaj etykietę i sprawdź dane przed zapisaniem produktu.",
      },
    ],
  }),
  component: Scan,
});

interface SelectedImage extends PreparedLabelImage {
  fileName: string;
  previewUrl: string;
}

function Scan() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const previewUrl = useRef<string | null>(null);
  const selectionGeneration = useRef(0);
  const request = useRef<AbortController | null>(null);
  const requestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const proposalDraftKey = useRef<string | null>(null);
  const saveMutation = useFrozenMutation<{ id: string; draft: ProductDraft }>("label-save");
  const [selectedImage, setSelectedImage] = useState<SelectedImage | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const [proposal, setProposal] = useState<LabelProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unresolved = saveMutation.command?.draft;
  const shownProposal =
    proposal ??
    (unresolved
      ? {
          basis_status: "per_100",
          name: unresolved.name,
          basis_unit: unresolved.basisUnit,
          kcal_per_100: unresolved.kcal,
          protein_per_100: unresolved.protein,
          fat_per_100: unresolved.fat,
          carbs_per_100: unresolved.carbs,
          warnings: [],
        }
      : null);
  const shownDraftKey = proposalDraftKey.current ?? "label-product:unconfirmed";

  const stopRequest = () => {
    request.current?.abort();
    request.current = null;
    if (requestTimer.current !== null) clearTimeout(requestTimer.current);
    requestTimer.current = null;
  };

  const discardProposal = () => {
    if (proposalDraftKey.current) discardPrivateDraft(proposalDraftKey.current);
    proposalDraftKey.current = null;
  };

  const releasePreview = () => {
    if (!previewUrl.current) return;
    revokePrivateObjectUrl(previewUrl.current);
    previewUrl.current = null;
  };

  useEffect(
    () => () => {
      selectionGeneration.current += 1;
      stopRequest();
      discardProposal();
      releasePreview();
    },
    [],
  );

  const clearSelection = () => {
    selectionGeneration.current += 1;
    stopRequest();
    discardProposal();
    releasePreview();
    setProposal(null);
    setSelectedImage(null);
    setIsPreparing(false);
    setIsReading(false);
    setError(null);
  };

  const onFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;

    selectionGeneration.current += 1;
    const generation = selectionGeneration.current;
    stopRequest();
    discardProposal();
    releasePreview();
    setProposal(null);
    setIsReading(false);
    setSelectedImage(null);
    setError(null);
    setIsPreparing(true);

    try {
      const prepared = await prepareLabelImage(file);
      if (generation !== selectionGeneration.current) return;
      const objectUrl = createPrivateObjectUrl(prepared.blob);
      previewUrl.current = objectUrl;
      setSelectedImage({ ...prepared, fileName: file.name, previewUrl: objectUrl });
    } catch (preparationError) {
      if (generation !== selectionGeneration.current) return;
      setError(
        preparationError instanceof LabelImagePreparationError
          ? preparationError.message
          : "Nie udało się przygotować zdjęcia. Wybierz inne zdjęcie JPEG, PNG lub WebP.",
      );
    } finally {
      if (generation === selectionGeneration.current) setIsPreparing(false);
    }
  };

  const readImage = async () => {
    if (!selectedImage || isReading) return;
    stopRequest();
    const generation = ++selectionGeneration.current;
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    setIsReading(true);
    // Start before fetch so the limit includes uploading and reading the response body.
    requestTimer.current = setTimeout(() => {
      if (generation !== selectionGeneration.current) return;
      selectionGeneration.current += 1;
      stopRequest();
      setIsReading(false);
      setError("Odczyt przekroczył 30 sekund. Spróbuj ponownie lub wpisz dane ręcznie.");
    }, 30_000);
    try {
      const result = await readLabelImage(selectedImage.blob, controller.signal);
      if (controller.signal.aborted || generation !== selectionGeneration.current) return;
      proposalDraftKey.current = `label-product:${crypto.randomUUID()}`;
      setProposal(result);
    } catch (readError) {
      if (controller.signal.aborted || generation !== selectionGeneration.current) return;
      setError(
        readError instanceof ApiRequestError && readError.code === "AI_LIMIT"
          ? "Limit odczytów został osiągnięty. Wpisz dane ręcznie lub spróbuj później."
          : readError instanceof Error
            ? readError.message
            : "Nie udało się odczytać etykiety. Spróbuj ponownie lub wpisz dane ręcznie.",
      );
    } finally {
      if (generation === selectionGeneration.current) {
        if (requestTimer.current !== null) clearTimeout(requestTimer.current);
        requestTimer.current = null;
        request.current = null;
        setIsReading(false);
      }
    }
  };

  const saveProposal = async (draft: ProductDraft) => {
    const generation = selectionGeneration.current;
    await saveMutation.run({ id: crypto.randomUUID(), draft }, (command, key) =>
      createProduct(
        {
          id: command.id,
          name: command.draft.name,
          basis_unit: command.draft.basisUnit,
          kcal_per_100: command.draft.kcal,
          protein_per_100: command.draft.protein,
          fat_per_100: command.draft.fat,
          carbs_per_100: command.draft.carbs,
        },
        key,
      ),
    );
    try {
      await queryClient.invalidateQueries({ queryKey: ["products"] }, { throwOnError: true });
    } catch {
      setError("Produkt zapisany. Nie udało się odświeżyć listy produktów.");
    }
    if (generation !== selectionGeneration.current) return;
    clearSelection();
    await navigate({ to: "/produkty" });
  };

  return (
    <div className="animate-rise mx-auto max-w-lg">
      <PageHeader title="Skanuj etykietę" subtitle="Sprawdź odczyt przed zapisaniem" />
      <Card className="space-y-5 p-6">
        {shownProposal ? (
          <div className="space-y-4">
            <h2 className="font-semibold">Sprawdź i popraw dane produktu</h2>
            <p className="text-sm text-muted-foreground">
              Produkt zostanie zapisany dopiero po zatwierdzeniu.
            </p>
            {shownProposal.basis_status !== "per_100" && (
              <p role="status" className="text-sm text-muted-foreground">
                Podaj wartości na 100 g lub 100 ml. Wartości na porcję nie są przeliczane.
              </p>
            )}
            {shownProposal.warnings.map((warning, index) => (
              <p key={index} className="text-sm text-muted-foreground">
                {warning}
              </p>
            ))}
            <ProductForm
              key={shownDraftKey}
              frozen={saveMutation.frozen}
              draftKey={shownDraftKey}
              initial={{
                name: shownProposal.name ?? "",
                basisUnit: shownProposal.basis_unit ?? "",
                kcal: shownProposal.kcal_per_100 ?? "",
                protein: shownProposal.protein_per_100 ?? "",
                fat: shownProposal.fat_per_100 ?? "",
                carbs: shownProposal.carbs_per_100 ?? "",
              }}
              onSubmit={saveProposal}
              onCancel={clearSelection}
            />
          </div>
        ) : (
          <>
            <div className="text-center">
              <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary-soft text-primary">
                <Camera className="h-7 w-7" aria-hidden="true" />
              </span>
              <h2 className="mt-4 font-semibold">Wybierz czytelne zdjęcie etykiety</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Wybierz zdjęcie z widocznymi wartościami na 100 g lub 100 ml. Po odczycie sprawdzisz
                i poprawisz dane przed zapisaniem produktu.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="label-image-input">
                Wybierz zdjęcie etykiety
              </label>
              <input
                id="label-image-input"
                type="file"
                accept="image/jpeg,image/png,image/webp,.heic,.heif"
                onChange={onFileChange}
                aria-describedby="label-image-help"
                className="block min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
              <p id="label-image-help" className="text-xs text-muted-foreground">
                Jeden plik JPEG, PNG lub WebP, maksymalnie 10 MiB po przygotowaniu. HEIC/HEIF wymaga
                wyeksportowania do JPEG.
              </p>
            </div>

            {isPreparing && (
              <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
                Przygotowuję zdjęcie na tym urządzeniu…
              </p>
            )}
            {isReading && (
              <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                Odczytuję etykietę…
              </p>
            )}
            {error && (
              <p
                className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-strong"
                role="alert"
              >
                {error}
              </p>
            )}

            {selectedImage && (
              <div className="space-y-3" aria-live="polite">
                <img
                  className="mx-auto max-h-80 w-auto rounded-lg border object-contain"
                  src={selectedImage.previewUrl}
                  alt="Podgląd przygotowanego zdjęcia etykiety"
                />
                <p className="text-center text-sm text-muted-foreground">
                  {selectedImage.fileName} · {selectedImage.width} × {selectedImage.height} px ·
                  JPEG
                </p>
                <Btn type="button" variant="outline" className="w-full" onClick={clearSelection}>
                  <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                  Anuluj wybór
                </Btn>
              </div>
            )}

            <Btn
              type="button"
              className="w-full"
              disabled={!selectedImage || isPreparing || isReading}
              onClick={() => void readImage()}
            >
              Odczytaj etykietę
            </Btn>

            {error && (
              <Btn type="button" variant="outline" className="w-full" onClick={clearSelection}>
                <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                Wybierz inne zdjęcie
              </Btn>
            )}
          </>
        )}

        <Link to="/produkty" className="inline-flex w-full">
          <Btn type="button" className="w-full" variant="soft">
            Przejdź do ręcznego dodawania
          </Btn>
        </Link>
      </Card>
    </div>
  );
}
