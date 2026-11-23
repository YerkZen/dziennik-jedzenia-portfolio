import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSupportedLabelImageType,
  MAX_PREPARED_LABEL_IMAGE_BYTES,
  prepareLabelImage,
} from "./image-preparation";

const jpegHeader = [0xff, 0xd8, 0xff, 0xe0];

function imageFile(name: string, type: string, header = jpegHeader): File {
  const file = new File(["source"], name, { type });
  Object.defineProperty(file, "slice", {
    configurable: true,
    value: () => ({
      arrayBuffer: async () => Uint8Array.from(header).buffer as ArrayBuffer,
    }),
  });
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("prepareLabelImage", () => {
  it("recognizes JPEG, PNG and WebP from file signatures", async () => {
    const formats = [
      ["label.jpg", "image/jpeg", [0xff, 0xd8, 0xff]],
      ["label.png", "image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
      ["label.webp", "image/webp", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]],
    ] as const;

    for (const [name, type, signature] of formats) {
      await expect(getSupportedLabelImageType(imageFile(name, type, [...signature]))).resolves.toBe(
        type,
      );
    }
  });

  it("resizes, paints transparency white, re-encodes as JPEG and releases the bitmap", async () => {
    const order: string[] = [];
    const context = {
      fillStyle: "",
      fillRect: vi.fn(() => order.push("fill")),
      drawImage: vi.fn(() => order.push("draw")),
    } as unknown as CanvasRenderingContext2D;
    const encoded = new Blob(["jpeg"], { type: "image/jpeg" });
    const canvas = document.createElement("canvas");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation((callback) => callback(encoded));
    const bitmap = { width: 4096, height: 1024, close: vi.fn() };
    const decode = vi.fn().mockResolvedValue(bitmap);
    vi.stubGlobal("createImageBitmap", decode);

    const prepared = await prepareLabelImage(imageFile("label.jpg", "image/jpeg"));

    expect(decode).toHaveBeenCalledWith(expect.any(File), { imageOrientation: "from-image" });
    expect(prepared).toMatchObject({ width: 2048, height: 512, originalType: "image/jpeg" });
    expect(prepared.blob.type).toBe("image/jpeg");
    expect(context.fillStyle).toBe("#fff");
    expect(order).toEqual(["fill", "draw"]);
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.9);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("rejects HEIC with an export instruction before attempting to decode it", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(prepareLabelImage(imageFile("label.heic", "image/heic"))).rejects.toMatchObject({
      code: "HEIC_UNSUPPORTED",
      message: expect.stringContaining("Wyeksportuj"),
    });
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects a mislabeled image and never decodes it", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);

    await expect(prepareLabelImage(imageFile("label.png", "image/png"))).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
    expect(decode).not.toHaveBeenCalled();
  });

  it("reports an unreadable supported image without leaking decode errors", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("decoder failure")));

    await expect(prepareLabelImage(imageFile("label.jpg", "image/jpeg"))).rejects.toMatchObject({
      code: "UNREADABLE_IMAGE",
      message: expect.stringContaining("Nie można odczytać obrazu"),
    });
  });

  it("rejects oversized prepared output and still releases the bitmap", async () => {
    const context = {
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) =>
      callback(
        new Blob([new Uint8Array(MAX_PREPARED_LABEL_IMAGE_BYTES + 1)], { type: "image/jpeg" }),
      ),
    );
    const bitmap = { width: 800, height: 600, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));

    await expect(prepareLabelImage(imageFile("label.jpg", "image/jpeg"))).rejects.toMatchObject({
      code: "IMAGE_TOO_LARGE",
    });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
