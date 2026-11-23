// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { MAX_PREPARED_LABEL_IMAGE_BYTES } from "../../src/lib/label/limits";
import { parseLabelUpload } from "../../worker/api/label-reading";

function tinyPng(): Buffer {
  const image = new PNG({ width: 1, height: 1 });
  image.data.fill(0);
  return PNG.sync.write(image);
}

function tinyJpeg(): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff,
    0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00, 0xff, 0xd9,
  ]);
}

function tinyWebp(): Buffer {
  return Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x12, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
    0x05, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
}

function multipartRequest(
  entries: Array<{ name: string; bytes: Uint8Array; type: string; filename?: string }>,
): Request {
  const form = new FormData();
  for (const entry of entries)
    form.append(
      entry.name,
      new Blob([entry.bytes as unknown as BlobPart], { type: entry.type }),
      entry.filename ?? "label",
    );
  return new Request("https://localhost:5173/api/v1/label-readings", {
    method: "POST",
    body: form,
  });
}

describe("label upload parser", () => {
  it("accepts structurally valid JPEG, PNG and WebP containers with matching MIME", async () => {
    const jpeg = await parseLabelUpload(
      multipartRequest([
        { name: "image", bytes: tinyJpeg(), type: "image/jpeg", filename: "label.jpg" },
      ]),
    );
    expect(jpeg.kind).toBe("valid");
    if (jpeg.kind === "valid") expect(jpeg.upload.contentType).toBe("image/jpeg");

    const png = await parseLabelUpload(
      multipartRequest([
        { name: "image", bytes: tinyPng(), type: "image/png", filename: "label.png" },
      ]),
    );
    expect(png.kind).toBe("valid");
    if (png.kind === "valid") expect(png.upload.contentType).toBe("image/png");

    const webp = await parseLabelUpload(
      multipartRequest([
        { name: "image", bytes: tinyWebp(), type: "image/webp", filename: "label.webp" },
      ]),
    );
    expect(webp.kind).toBe("valid");
    if (webp.kind === "valid") expect(webp.upload.contentType).toBe("image/webp");
  });

  it("rejects spoofed MIME and truncated image containers", async () => {
    const spoofed = await parseLabelUpload(
      multipartRequest([{ name: "image", bytes: tinyPng(), type: "image/jpeg" }]),
    );
    expect(spoofed).toEqual({ kind: "unsupported-image" });

    const truncated = await parseLabelUpload(
      multipartRequest([
        {
          name: "image",
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          type: "image/png",
        },
      ]),
    );
    expect(truncated).toEqual({ kind: "unsupported-image" });
  });

  it("requires exactly one image field and enforces the image size even within body overhead", async () => {
    const multipleFields = await parseLabelUpload(
      multipartRequest([
        { name: "image", bytes: tinyPng(), type: "image/png" },
        { name: "prompt", bytes: new Uint8Array([1]), type: "application/octet-stream" },
      ]),
    );
    expect(multipleFields).toEqual({ kind: "bad-request" });

    const oversized = await parseLabelUpload(
      multipartRequest([
        {
          name: "image",
          bytes: new Uint8Array(MAX_PREPARED_LABEL_IMAGE_BYTES + 1),
          type: "image/png",
        },
      ]),
    );
    expect(oversized).toEqual({ kind: "too-large" });
  }, 30_000);
});
