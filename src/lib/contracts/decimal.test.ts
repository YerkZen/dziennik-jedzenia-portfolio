import { describe, expect, it } from "vitest";
import {
  calendarDateSchema,
  decimalTextSchema,
  formDecimalTextSchema,
  goalsWriteSchema,
  mealCreateSchema,
  nameSchema,
  positiveDecimalTextSchema,
  productCreateSchema,
  warsawToday,
} from "./decimal";

describe("shared decimal and DTO contracts", () => {
  it("accepts only bounded decimal strings in the API wire format", () => {
    for (const value of ["0", "0.00", "1.01", "99999999.99"])
      expect(decimalTextSchema.safeParse(value).success, value).toBe(true);
    for (const value of [1, "", "-1", "1,25", "1.001", "1e3", "NaN", "Infinity", "100000000"])
      expect(decimalTextSchema.safeParse(value).success, String(value)).toBe(false);
    expect(positiveDecimalTextSchema.safeParse("0.00").success).toBe(false);
    expect(positiveDecimalTextSchema.safeParse("0.01").success).toBe(true);
  });

  it("normalizes a single form decimal comma without accepting invalid precision", () => {
    expect(formDecimalTextSchema.parse(" 12,30 ")).toBe("12.30");
    expect(formDecimalTextSchema.safeParse("1.001").success).toBe(false);
    expect(formDecimalTextSchema.safeParse("1,2,3").success).toBe(false);
  });

  it("trims bounded names and rejects empty or overlong values", () => {
    expect(nameSchema.parse("  Ryż  ")).toBe("Ryż");
    expect(nameSchema.safeParse(" \t ").success).toBe(false);
    expect(nameSchema.safeParse("x".repeat(161)).success).toBe(false);
  });

  it("rejects impossible dates and DTO properties outside the OpenAPI contract", () => {
    expect(calendarDateSchema.safeParse("2024-02-29").success).toBe(true);
    expect(calendarDateSchema.safeParse("2025-02-29").success).toBe(false);
    const product = {
      id: "7c51cfd6-6759-4f17-8eb0-0939376d42f0",
      name: " Ryż ",
      basis_unit: "g",
      kcal_per_100: "350",
      protein_per_100: "7",
      fat_per_100: "1",
      carbs_per_100: "78",
    };
    expect(productCreateSchema.parse(product).name).toBe("Ryż");
    expect(productCreateSchema.safeParse({ ...product, owner_id: "forbidden" }).success).toBe(
      false,
    );
    expect(productCreateSchema.safeParse({ ...product, snapshot: {} }).success).toBe(false);
  });

  it("requires positive goal values and the current Europe/Warsaw date", () => {
    const goals = {
      id: "7c51cfd6-6759-4f17-8eb0-0939376d42f0",
      expected_date: warsawToday(),
      kcal_goal: "2000",
      protein_goal: "120",
      fat_goal: "70",
      carbs_goal: "240",
    };
    expect(goalsWriteSchema.safeParse(goals).success).toBe(true);
    expect(goalsWriteSchema.safeParse({ ...goals, fat_goal: "0" }).success).toBe(false);
    expect(goalsWriteSchema.safeParse({ ...goals, expected_date: "2099-01-01" }).success).toBe(
      false,
    );
  });

  it("rejects caller supplied meal snapshots", () => {
    const meal = {
      id: "7c51cfd6-6759-4f17-8eb0-0939376d42f0",
      name: "Lunch",
      entry_date: warsawToday(),
      category: "lunch",
      items: [
        {
          kind: "new",
          item_id: "876c4dc4-bbd6-4c10-8bad-c6849e4c4d9a",
          product_id: "c91854fc-4626-45ea-ae89-9747d4e88c30",
          expected_product_revision: 1,
          quantity: "100",
        },
      ],
    };
    expect(mealCreateSchema.safeParse(meal).success).toBe(true);
    const withSnapshot = {
      ...meal,
      items: [{ ...meal.items[0], product_name: "forbidden" }],
    };
    expect(mealCreateSchema.safeParse(withSnapshot).success).toBe(false);
  });
});
