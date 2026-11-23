import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProfileStatistics from "./ProfileStatistics";
import { statisticsResponse } from "../../../../tests/helpers/statistics-response";
vi.mock("./WeightMeasurements", () => ({ WeightMeasurements: () => null }));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});
function mount() {
  const client = new QueryClient();
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <ProfileStatistics ownerId="fixture-owner" />
    </QueryClientProvider>,
  );
}
function success(input: RequestInfo | URL) {
  const url = new URL(String(input), "https://app.example");
  return statisticsResponse(url.searchParams.get("from")!, url.searchParams.get("to")!);
}
describe("Statistics view states", () => {
  it("shows a retryable error instead of an empty chart, then loads on explicit retry", async () => {
    let fail = true;
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      fail ? Response.json({ message: "Unavailable" }, { status: 503 }) : success(input),
    );
    vi.stubGlobal("fetch", fetcher);
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Nie udało się wczytać statystyk");
    expect(screen.queryByRole("table")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Ponów" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("keeps invalid draft dates and does not request them", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => success(input));
    vi.stubGlobal("fetch", fetcher);
    mount();
    await screen.findByRole("table");
    fireEvent.change(screen.getByLabelText("Od"), { target: { value: "2026-02-01" } });
    fireEvent.change(screen.getByLabelText("Do"), { target: { value: "2026-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Pokaż" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Data Do nie może poprzedzać");
    expect(screen.getByLabelText("Od")).toHaveValue("2026-02-01");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("honors rate-limit cooldown in the retry button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ message: "Wait" }, { status: 429, headers: { "Retry-After": "60" } }),
      ),
    );
    mount();
    expect(await screen.findByRole("button", { name: "Ponów za 60 s" })).toBeDisabled();
  });
  it("cancels an obsolete range and ignores its late response", async () => {
    let finish: ((response: Response) => void) | undefined;
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("from=2024-01-01")) {
        signal = init?.signal;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return success(input);
    });
    vi.stubGlobal("fetch", fetcher);
    mount();
    await screen.findByRole("table");
    const change = (from: string, to: string) => {
      fireEvent.change(screen.getByLabelText("Od"), { target: { value: from } });
      fireEvent.change(screen.getByLabelText("Do"), { target: { value: to } });
      fireEvent.click(screen.getByRole("button", { name: "Pokaż" }));
    };
    change("2024-01-01", "2024-01-01");
    await waitFor(() => expect(finish).toBeDefined());
    change("2024-01-02", "2024-01-02");
    await screen.findByText("02.01.2024");
    expect(signal?.aborted).toBe(true);
    finish!(statisticsResponse("2024-01-01", "2024-01-01"));
    await waitFor(() => expect(screen.queryByText("01.01.2024")).not.toBeInTheDocument());
  });
});
