import { describe, expect, it, vi } from "vitest";
import { formatDecimalHalfUp } from "@/lib/contracts/decimal";
import { macroEnergyExact, portionExact, sumExact } from "./decimal";

describe("exact decimal nutrition math", () => {
  it("reuses timezone formatting across a year while observing Warsaw midnight and DST", async () => {
    vi.resetModules();
    const NativeFormatter = Intl.DateTimeFormat;
    const constructors = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (
      ...args: Parameters<typeof Intl.DateTimeFormat>
    ) {
      return new NativeFormatter(...args);
    } as typeof Intl.DateTimeFormat);
    try {
      const { warsawToday } = await import("@/lib/contracts/decimal");
      for (let i = 0; i < 366; i++) {
        const date = new Date(Date.UTC(2025, 9, 1 + i, 12));
        expect(warsawToday(date)).toBe(date.toISOString().slice(0, 10));
      }
      expect(warsawToday(new Date("2026-03-28T22:59:59Z"))).toBe("2026-03-28");
      expect(warsawToday(new Date("2026-03-28T23:00:00Z"))).toBe("2026-03-29");
      expect(warsawToday(new Date("2026-07-01T21:59:59Z"))).toBe("2026-07-01");
      expect(warsawToday(new Date("2026-07-01T22:00:00Z"))).toBe("2026-07-02");
      expect(constructors).toHaveBeenCalledTimes(1);
    } finally {
      constructors.mockRestore();
    }
  });
  it("sums unrounded portions and formats only at the display boundary", () => {
    const perTenth = { kcal: "0.01", protein: "0", fat: "0", carbs: "0" };
    const portions = [
      portionExact(perTenth, "1"),
      portionExact(perTenth, "1"),
      portionExact(perTenth, "1"),
    ];

    expect(sumExact(portions).kcal).toBe("0.0003");
    expect(formatDecimalHalfUp(sumExact(portions).kcal)).toBe("0");
    expect(formatDecimalHalfUp("1.005")).toBe("1.01");
  });

  it("calculates the macro preview with exact decimal arithmetic", () => {
    expect(macroEnergyExact("1,25", "0,50", "2")).toBe("17.5");
    expect(macroEnergyExact("not-a-number", "0", "0")).toBeNull();
  });
});
