import { MAX_PREPARED_LABEL_IMAGE_BYTES } from "./limits";

export { MAX_PREPARED_LABEL_IMAGE_BYTES };
export const MAX_LABEL_IMAGE_SIDE = 2048;

export const LABEL_IMAGE_MESSAGES = {
  unsupported: "Nieobsługiwany format pliku. Wybierz zdjęcie JPEG, PNG lub WebP.",
  heic: "Plik HEIC/HEIF nie jest obsługiwany bezpośrednio. Wyeksportuj go lub wybierz zdjęcie JPEG.",
  unreadable: "Nie można odczytać obrazu. Wybierz poprawne zdjęcie JPEG, PNG lub WebP.",
  tooLarge: "Przygotowane zdjęcie przekracza limit 10 MiB. Wybierz mniejszy obraz.",
} as const;

export type SupportedLabelImageType = "image/jpeg" | "image/png" | "image/webp";

export interface PreparedLabelImage {
  blob: Blob;
  width: number;
  height: number;
  originalType: SupportedLabelImageType;
}

export class LabelImagePreparationError extends Error {
  constructor(
    message: string,
    readonly code:
      "UNSUPPORTED_FORMAT" | "HEIC_UNSUPPORTED" | "UNREADABLE_IMAGE" | "IMAGE_TOO_LARGE",
  ) {
    super(message);
    this.name = "LabelImagePreparationError";
  }
}

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function isHeicFile(file: File, bytes: Uint8Array): boolean {
  const extension = file.name.toLowerCase().split(".").at(-1);
  const heifBrands = new Set([
    "heic",
    "heix",
    "hevc",
    "hevx",
    "heif",
    "heis",
    "hevm",
    "hevs",
    "mif1",
    "msf1",
  ]);
  return (
    extension === "heic" ||
    extension === "heif" ||
    file.type.toLowerCase() === "image/heic" ||
    file.type.toLowerCase() === "image/heif" ||
    (readAscii(bytes, 4, 4) === "ftyp" && heifBrands.has(readAscii(bytes, 8, 4)))
  );
}

function detectImageType(bytes: Uint8Array): SupportedLabelImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    readAscii(bytes, 1, 3) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    readAscii(bytes, 0, 4) === "RIFF" &&
    readAscii(bytes, 8, 4) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export async function getSupportedLabelImageType(file: File): Promise<SupportedLabelImageType> {
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (isHeicFile(file, header)) {
    throw new LabelImagePreparationError(LABEL_IMAGE_MESSAGES.heic, "HEIC_UNSUPPORTED");
  }

  const actualType = detectImageType(header);
  if (!actualType) {
    throw new LabelImagePreparationError(LABEL_IMAGE_MESSAGES.unsupported, "UNSUPPORTED_FORMAT");
  }

  const declaredType = file.type.toLowerCase();
  if (declaredType && declaredType !== actualType && declaredType !== "application/octet-stream") {
    throw new LabelImagePreparationError(LABEL_IMAGE_MESSAGES.unsupported, "UNSUPPORTED_FORMAT");
  }
  return actualType;
}

type DecodedImage = ImageBitmap | HTMLImageElement;

async function decodeImage(file: File): Promise<{ image: DecodedImage; release: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { image: bitmap, release: () => bitmap.close() };
    } catch {
      throw new LabelImagePreparationError(LABEL_IMAGE_MESSAGES.unreadable, "UNREADABLE_IMAGE");
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(LABEL_IMAGE_MESSAGES.unreadable));
      element.src = objectUrl;
    });
    return { image, release: () => URL.revokeObjectURL(objectUrl) };
  } catch {
    URL.revokeObjectURL(objectUrl);
    throw new LabelImagePreparationError(LABEL_IMAGE_MESSAGES.unreadable, "UNREADABLE_IMAGE");
  }
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(LABEL_IMAGE_MESSAGES.unreadable))),
      "image/jpeg",
      0.9,
    );
  });
}

export async function prepareLabelImage(file: File): Promise<PreparedLabelImage> {
  const originalType = await getSupportedLabelImageType(file);
  const { image, release } = await decodeImage(file);
  const sourceWidth = "naturalWidth" in image ? image.naturalWidth : image.width;
  const sourceHeight = "naturalHeight" in image ? image.naturalHeight : image.height;
  if (!sourceWidth || !sourceHeight) {
    release();
    throw new LabelImagePreparationError(LABEL_IMAGE_MESSAGES.unreadable, "UNREADABLE_IMAGE");
  }

  const scale = Math.min(1, MAX_LABEL_IMAGE_SIDE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error(LABEL_IMAGE_MESSAGES.unreadable);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await canvasBlob(canvas);
    if (blob.size > MAX_PREPARED_LABEL_IMAGE_BYTES) {
      throw new LabelImagePreparationError(LABEL_IMAGE_MESSAGES.tooLarge, "IMAGE_TOO_LARGE");
    }
    return { blob, width, height, originalType };
  } catch (error) {
    if (error instanceof LabelImagePreparationError) throw error;
    throw new LabelImagePreparationError(LABEL_IMAGE_MESSAGES.unreadable, "UNREADABLE_IMAGE");
  } finally {
    release();
    canvas.width = 0;
    canvas.height = 0;
  }
}
