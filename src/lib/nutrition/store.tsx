import type React from "react";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { warsawToday } from "@/lib/contracts/decimal";
import type { DiaryEntry, Goals, MealType, Product, ProductSet } from "./types";

/**
 * In-memory prototype store. All mutations go through these actions so the
 * real data layer can replace this module without touching UI components.
 */
interface Store {
  today: string;
  selectedDate: string;
  setSelectedDate: (d: string) => void;
  products: Product[];
  sets: ProductSet[];
  entries: DiaryEntry[];
  goals: Goals;
  addProduct: (p: Omit<Product, "id">) => Product;
  updateProduct: (p: Product) => void;
  deleteProduct: (id: string) => void;
  addEntries: (date: string, meal: MealType, items: { productId: string; grams: number }[]) => void;
  updateEntryGrams: (id: string, grams: number) => void;
  removeEntry: (id: string) => void;
  saveSet: (name: string, items: { productId: string; grams: number }[]) => void;
  setGoals: (g: Goals) => void;
}

// Keep one context instance across hot reloads so provider and consumers always match.
const g = globalThis as unknown as { __nutritionCtx?: React.Context<Store | null> };
const Ctx = (g.__nutritionCtx ??= createContext<Store | null>(null));
const uid = () => Math.random().toString(36).slice(2, 10);

export function NutritionProvider({ children }: { children: ReactNode }) {
  const [today] = useState(() => warsawToday());
  const [selectedDate, setSelectedDate] = useState(today);
  const [products, setProducts] = useState<Product[]>([]);
  const [sets, setSets] = useState<ProductSet[]>([]);
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [goals, setGoals] = useState<Goals>({ kcal: 0, protein: 0, fat: 0, carbs: 0 });

  const addProduct = useCallback((p: Omit<Product, "id">) => {
    const np = { ...p, id: uid() };
    setProducts((l) => [np, ...l]);
    return np;
  }, []);

  const value = useMemo<Store>(
    () => ({
      today,
      selectedDate,
      setSelectedDate,
      products,
      sets,
      entries,
      goals,
      addProduct,
      updateProduct: (p) => setProducts((l) => l.map((x) => (x.id === p.id ? p : x))),
      deleteProduct: (id) => setProducts((l) => l.filter((x) => x.id !== id)),
      addEntries: (date, meal, items) =>
        setEntries((l) => [...l, ...items.map((i) => ({ ...i, id: uid(), date, meal }))]),
      updateEntryGrams: (id, grams) =>
        setEntries((l) => l.map((e) => (e.id === id ? { ...e, grams } : e))),
      removeEntry: (id) => setEntries((l) => l.filter((e) => e.id !== id)),
      saveSet: (name, items) => setSets((l) => [{ id: uid(), name, items }, ...l]),
      setGoals,
    }),
    [today, selectedDate, products, sets, entries, goals, addProduct],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNutrition() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useNutrition must be used within NutritionProvider");
  return c;
}
