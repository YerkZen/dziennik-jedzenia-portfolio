import { afterEach, describe, expect, it, vi } from "vitest";
import { getStatistics } from "../../src/lib/api/statistics";
import { statisticsResponse } from "../helpers/statistics-response";

afterEach(() => vi.unstubAllGlobals());

describe("Statistics page loading", () => {
  it("requests disjoint inclusive pages sequentially and reports full progress", async () => {
    const progress: unknown[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://app.example");
      return statisticsResponse(url.searchParams.get("from")!, url.searchParams.get("to")!);
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await getStatistics(
      { from: "2024-01-01", to: "2025-01-01" },
      { onProgress: (value) => progress.push(value) },
    );
    expect(result.days).toHaveLength(367);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/v1/statistics?from=2024-01-01&to=2024-12-31",
      "/api/v1/statistics?from=2025-01-01&to=2025-01-01",
    ]);
    expect(progress).toEqual([
      { completed: 0, total: 2 },
      { completed: 1, total: 2 },
      { completed: 2, total: 2 },
    ]);
  });
  it("never returns a partial series if a later page fails", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ++call === 1
          ? statisticsResponse("2024-01-01", "2024-12-31")
          : Response.json({ code: "SERVICE_UNAVAILABLE", message: "Unavailable" }, { status: 503 }),
      ),
    );
    await expect(getStatistics({ from: "2024-01-01", to: "2025-01-01" })).rejects.toMatchObject({
      status: 503,
    });
    expect(call).toBe(2);
  });
  it("rejects a valid response for the wrong requested dates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => statisticsResponse("2024-01-02", "2024-01-02")),
    );
    await expect(getStatistics({ from: "2024-01-01", to: "2024-01-01" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
  it("forwards cancellation and prevents subsequent pages after an abort", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      return statisticsResponse("2024-01-01", "2024-12-31");
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(
      getStatistics({ from: "2024-01-01", to: "2025-01-01" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves Retry-After without automatically repeating a rate-limited request", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { code: "RATE_LIMIT", message: "Wait" },
        { status: 429, headers: { "Retry-After": "60" } },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(getStatistics({ from: "2024-01-01", to: "2024-01-01" })).rejects.toMatchObject({
      retryAfterSeconds: 60,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
