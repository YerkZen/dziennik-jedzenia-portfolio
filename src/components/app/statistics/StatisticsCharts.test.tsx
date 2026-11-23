import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StatisticsCharts } from "./StatisticsCharts";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("defers offscreen chart rendering until its frame approaches the viewport", () => {
  const intersections: (() => void)[] = [];
  class VisibilityObserver {
    constructor(callback: IntersectionObserverCallback) {
      intersections.push(() =>
        callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        ),
      );
    }
    observe() {}
    disconnect() {}
  }
  class SizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [{ target, contentRect: { width: 640, height: 240 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", VisibilityObserver);
  vi.stubGlobal("ResizeObserver", SizeObserver);
  render(
    <StatisticsCharts
      today="2026-01-02"
      days={[
        { date: "2026-01-01", kcal: "100", meal_count: 1, weight_kg: "70", weight_revision: 1 },
        { date: "2026-01-02", kcal: "200", meal_count: 1, weight_kg: "71", weight_revision: 1 },
      ]}
    />,
  );
  const chart = screen.getByRole("img", { name: "Historia wagi" });
  expect(chart.querySelector(".recharts-surface")).toBeNull();
  act(() => intersections.forEach((enter) => enter()));
  expect(within(chart).getByText("01.01")).toBeInTheDocument();
  expect(within(chart).getByText("02.01")).toBeInTheDocument();
  expect(chart.querySelectorAll(".recharts-line-dot")).toHaveLength(2);
});
it("renders date and value axes for both series, including a useful weight scale", () => {
  class Observer {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb(
        [{ target, contentRect: { width: 640, height: 240 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", Observer);
  render(
    <StatisticsCharts
      today="2026-01-02"
      days={[
        { date: "2026-01-01", kcal: "100", meal_count: 1, weight_kg: "70", weight_revision: 1 },
        { date: "2026-01-02", kcal: "200", meal_count: 1, weight_kg: "71", weight_revision: 1 },
      ]}
    />,
  );
  for (const label of ["Dzienne kalorie", "Historia wagi"]) {
    const chart = screen.getByRole("img", { name: label });
    expect(within(chart).getByText("01.01")).toBeInTheDocument();
    expect(within(chart).getByText("02.01")).toBeInTheDocument();
  }
  expect(
    within(screen.getByRole("img", { name: "Historia wagi" })).getByText("70"),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("img", { name: "Historia wagi" })).getByText("70,5"),
  ).toBeInTheDocument();
});
