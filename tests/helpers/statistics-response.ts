import { warsawToday } from "../../src/lib/contracts/decimal";

export function statisticsResponse(from: string, to: string): Response {
  const days = [];
  for (let time = Date.parse(from); time <= Date.parse(to); time += 86400000)
    days.push({
      date: new Date(time).toISOString().slice(0, 10),
      kcal: null,
      meal_count: 0,
      weight_kg: null,
      weight_revision: 0,
    });
  return Response.json({ from, to, today: warsawToday(), timezone: "Europe/Warsaw", days });
}
