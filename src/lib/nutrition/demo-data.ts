import { shiftDate } from "./calc";
import type { DiaryEntry, Goals, MealType, Product, ProductSet } from "./types";

/** Demo data kept in code — replaced later by the real data layer. */
export const DEMO_PRODUCTS: Product[] = [
  {
    id: "p1",
    name: "Płatki owsiane",
    kcal: 372,
    protein: 13.5,
    fat: 7,
    carbs: 58.7,
  },
  { id: "p2", name: "Jogurt naturalny 2%", kcal: 61, protein: 4.3, fat: 2, carbs: 6.2 },
  { id: "p3", name: "Banan", kcal: 89, protein: 1.1, fat: 0.3, carbs: 22.8 },
  { id: "p4", name: "Pierś z kurczaka", kcal: 99, protein: 21.5, fat: 1.3, carbs: 0 },
  { id: "p5", name: "Ryż basmati (ugotowany)", kcal: 130, protein: 2.7, fat: 0.3, carbs: 28.2 },
  { id: "p6", name: "Brokuł", kcal: 34, protein: 2.8, fat: 0.4, carbs: 6.6 },
  { id: "p7", name: "Oliwa z oliwek", kcal: 884, protein: 0, fat: 100, carbs: 0 },
  { id: "p8", name: "Chleb żytni razowy", kcal: 220, protein: 6, fat: 1.5, carbs: 45 },
  { id: "p9", name: "Jajko kurze", kcal: 140, protein: 12.5, fat: 9.7, carbs: 0.6 },
  { id: "p10", name: "Twaróg półtłusty", kcal: 133, protein: 18.7, fat: 4.7, carbs: 3.7 },
  { id: "p11", name: "Migdały", kcal: 579, protein: 21.2, fat: 49.9, carbs: 21.6 },
  { id: "p12", name: "Łosoś atlantycki", kcal: 208, protein: 20, fat: 13, carbs: 0 },
  { id: "p13", name: "Pomidor", kcal: 18, protein: 0.9, fat: 0.2, carbs: 3.9 },
];

export const DEMO_SETS: ProductSet[] = [
  {
    id: "s1",
    name: "Owsianka z bananem",
    items: [
      { productId: "p1", grams: 60 },
      { productId: "p2", grams: 150 },
      { productId: "p3", grams: 100 },
    ],
  },
  {
    id: "s2",
    name: "Kurczak, ryż, brokuł",
    items: [
      { productId: "p4", grams: 150 },
      { productId: "p5", grams: 200 },
      { productId: "p6", grams: 120 },
      { productId: "p7", grams: 10 },
    ],
  },
  {
    id: "s3",
    name: "Kanapki z jajkiem",
    items: [
      { productId: "p8", grams: 80 },
      { productId: "p9", grams: 110 },
      { productId: "p13", grams: 80 },
    ],
  },
];

export const DEMO_GOALS: Goals = { kcal: 2200, protein: 140, fat: 70, carbs: 250 };

const TEMPLATE: [MealType, string, number][][] = [
  [
    ["breakfast", "p1", 60],
    ["breakfast", "p2", 150],
    ["breakfast", "p3", 100],
    ["lunch", "p4", 150],
    ["lunch", "p5", 200],
    ["lunch", "p6", 120],
    ["snack", "p11", 30],
  ],
  [
    ["breakfast", "p8", 80],
    ["breakfast", "p9", 110],
    ["lunch", "p12", 140],
    ["lunch", "p5", 180],
    ["dinner", "p10", 200],
    ["dinner", "p13", 120],
  ],
  [
    ["breakfast", "p1", 70],
    ["breakfast", "p2", 200],
    ["lunch", "p4", 180],
    ["lunch", "p5", 220],
    ["lunch", "p7", 10],
    ["dinner", "p8", 90],
    ["dinner", "p9", 55],
    ["snack", "p3", 120],
  ],
];

export function buildDemoEntries(today: string): DiaryEntry[] {
  const out: DiaryEntry[] = [];
  for (let back = 13; back >= 1; back--) {
    const date = shiftDate(today, -back);
    (TEMPLATE[back % TEMPLATE.length] ?? []).forEach(([meal, productId, grams], i) => {
      out.push({ id: `d${back}-${i}`, date, meal, productId, grams: grams + ((back * 7) % 20) });
    });
  }
  // Today: partially filled day
  [
    ["breakfast", "p1", 60],
    ["breakfast", "p2", 150],
    ["breakfast", "p3", 100],
    ["lunch", "p4", 160],
    ["lunch", "p5", 200],
  ].forEach(([meal, productId, grams], i) =>
    out.push({
      id: `t-${i}`,
      date: today,
      meal: meal as MealType,
      productId: productId as string,
      grams: grams as number,
    }),
  );
  return out;
}
