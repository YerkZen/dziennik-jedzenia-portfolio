import { afterEach, describe, expect, it, vi } from "vitest";
import {
  statisticsSchema,
  statisticsRangeSchema,
  weightMutationSchema,
} from "../../src/lib/contracts/statistics";

afterEach(() => vi.useRealTimers());
const day = (date: string) => ({
  date,
  kcal: null,
  meal_count: 0,
  weight_kg: null,
  weight_revision: 0,
});

describe("Statistics wire invariants", () => {
  it("rejects missing, repeated or unordered dates instead of presenting incomplete history", () => {
    const input = {
      from: "2026-01-01",
      to: "2026-01-02",
      today: "2026-01-02",
      timezone: "Europe/Warsaw",
      days: [day("2026-01-01"), day("2026-01-02")],
    };
    expect(statisticsSchema.safeParse(input).success).toBe(true);
    for (const days of [
      [day("2026-01-01")],
      [day("2026-01-01"), day("2026-01-01")],
      [...input.days].reverse(),
    ]) {
      expect(statisticsSchema.safeParse({ ...input, days }).success).toBe(false);
    }
    expect(statisticsSchema.safeParse({ ...input, to: "2026-01-03" }).success).toBe(false);
  });
  it("distinguishes no meals, real zero calories and deleted weight revisions", () => {
    const input = {
      from: "2026-01-01",
      to: "2026-01-01",
      today: "2026-01-01",
      timezone: "Europe/Warsaw",
    };
    const parse = (entry: object) =>
      statisticsSchema.safeParse({ ...input, days: [{ ...day(input.from), ...entry }] }).success;
    expect(parse({})).toBe(true);
    expect(parse({ kcal: "0", meal_count: 1 })).toBe(true);
    expect(parse({ kcal: "0", meal_count: 0 })).toBe(false);
    expect(parse({ kcal: null, meal_count: 1 })).toBe(false);
    expect(parse({ weight_kg: null, weight_revision: 4 })).toBe(true);
    expect(parse({ weight_kg: "72.35", weight_revision: 0 })).toBe(false);
    expect(parse({ weight_kg: "72.35", weight_revision: 5 })).toBe(true);
    expect(parse({ kcal: "1.234567", meal_count: 2 })).toBe(true);
    expect(parse({ kcal: "1.2345678", meal_count: 2 })).toBe(false);
  });
  it("counts UTC calendar days across Warsaw daylight saving transitions", () => {
    for (const [from, to] of [
      ["2026-03-28", "2026-03-30"],
      ["2026-10-24", "2026-10-26"],
    ])
      expect(statisticsRangeSchema.safeParse({ from, to }).success).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T23:30:00Z"));
    expect(statisticsRangeSchema.safeParse({ from: "2026-11-01", to: "2026-11-01" }).success).toBe(
      true,
    );
    vi.setSystemTime(new Date("2026-10-31T22:30:00Z"));
    expect(statisticsRangeSchema.safeParse({ from: "2026-11-01", to: "2026-11-01" }).success).toBe(
      false,
    );
  });
  it("accepts a replay after a later deletion without resetting revisions", () => {
    const response = {
      date: "2026-01-01",
      applied_revision: 1,
      current_revision: 3,
      deleted: true,
      replayed: true,
    };
    expect(weightMutationSchema.safeParse(response).success).toBe(true);
    expect(weightMutationSchema.safeParse({ ...response, current_revision: 0 }).success).toBe(
      false,
    );
    expect(weightMutationSchema.safeParse({ ...response, applied_revision: 4 }).success).toBe(
      false,
    );
  });
});
