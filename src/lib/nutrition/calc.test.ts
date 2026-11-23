import { describe, expect, it } from "vitest";
import { forPortion, progress, shiftDate, totalFor } from "./calc";

describe("nutrition calc", () => {
  it("scales per-100g values to the portion", () => {
    expect(forPortion({ kcal: 200, protein: 10, fat: 5, carbs: 30 }, 150)).toEqual({
      kcal: 300,
      protein: 15,
      fat: 7.5,
      carbs: 45,
    });
  });

  it("sums multiple products and skips unknown ones", () => {
    const products = [{ id: "a", name: "A", kcal: 100, protein: 1, fat: 2, carbs: 3 }];
    expect(
      totalFor(
        [
          { productId: "a", grams: 200 },
          { productId: "missing", grams: 50 },
        ],
        products,
      ).kcal,
    ).toBe(200);
  });

  it("caps progress at 100%", () => {
    expect(progress(3000, 2000)).toBe(1);
  });

  it("shifts dates across month boundaries", () => {
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
  });
});
