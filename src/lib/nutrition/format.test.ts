import { expect, it } from "vitest";
import { formatNutritionValue } from "./format";
it("rounds exact decimal text half up only for display", () => {
  expect(formatNutritionValue("12345678901234567890.995")).toBe(
    "12\u00a0345\u00a0678\u00a0901\u00a0234\u00a0567\u00a0891",
  );
  expect(formatNutritionValue("67.600")).toBe("67,6");
  expect(formatNutritionValue("111.5", true)).toBe("111,50");
  expect(formatNutritionValue("1108")).toBe("1108");
});
