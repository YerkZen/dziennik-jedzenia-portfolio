import { afterEach, expect, it, vi } from "vitest";
import { apiRequest, onStatisticsMutation } from "../../src/lib/api/client";
afterEach(() => vi.unstubAllGlobals());
it("notifies once for every confirmed meal and weight mutation, never reads or rejected writes", async () => {
  const listener = vi.fn();
  const off = onStatisticsMutation(listener);
  let status = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({}, { status })),
  );
  try {
    for (const [path, method] of [
      ["diary-meals", "POST"],
      ["diary-meals/id", "PUT"],
      ["diary-meals/id", "DELETE"],
      ["weight-entries/2026-01-01", "PUT"],
      ["weight-entries/2026-01-01", "DELETE"],
    ] as const)
      await apiRequest(`/api/v1/${path}`, { method });
    expect(listener).toHaveBeenCalledTimes(5);
    await apiRequest("/api/v1/statistics");
    await apiRequest("/api/v1/products", { method: "POST" });
    status = 409;
    await expect(
      apiRequest("/api/v1/weight-entries/2026-01-01", { method: "PUT" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(listener).toHaveBeenCalledTimes(5);
    off();
    status = 200;
    await apiRequest("/api/v1/diary-meals", { method: "POST" });
    expect(listener).toHaveBeenCalledTimes(5);
  } finally {
    off();
  }
});
