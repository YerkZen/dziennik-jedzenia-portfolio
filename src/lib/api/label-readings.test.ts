import { afterEach, describe, expect, it, vi } from "vitest";
import { readLabelImage } from "./label-readings";

const proposal = {
  name: "Jogurt",
  basis_status: "per_100",
  basis_unit: "g",
  kcal_per_100: "62",
  protein_per_100: null,
  fat_per_100: "3.2",
  carbs_per_100: "4.7",
  missing_fields: ["protein_per_100"],
  warnings: [],
};
afterEach(() => vi.unstubAllGlobals());

describe("label reading client", () => {
  it("sends only one multipart image and the abort signal without overriding its content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(proposal));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const result = await readLabelImage(
      new Blob(["prepared"], { type: "image/jpeg" }),
      controller.signal,
    );
    expect(result.protein_per_100).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/label-readings");
    expect(init.signal).toBe(controller.signal);
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("same-origin");
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBeNull();
    expect(headers.get("X-Requested-With")).toBe("DziennikJedzenia");
    expect(Array.from((init.body as FormData).keys())).toEqual(["image"]);
  });

  it("does not display portion values as per-100 even if an inconsistent server response supplies them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ...proposal, basis_status: "per_portion" })),
    );
    const result = await readLabelImage(new Blob(), new AbortController().signal);
    expect([
      result.kcal_per_100,
      result.protein_per_100,
      result.fat_per_100,
      result.carbs_per_100,
    ]).toEqual([null, null, null, null]);
  });

  it("rejects malformed successful responses and does not retry failed requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ...proposal, protein_per_100: 0 }))
      .mockResolvedValueOnce(
        Response.json({ code: "AI_LIMIT", message: "Limit" }, { status: 429 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(readLabelImage(new Blob(), new AbortController().signal)).rejects.toThrow(
      /odczytać etykiety/,
    );
    await expect(readLabelImage(new Blob(), new AbortController().signal)).rejects.toMatchObject({
      code: "AI_LIMIT",
      status: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
