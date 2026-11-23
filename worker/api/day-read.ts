import { authenticatedClient } from "./products";
import type { Context } from "hono";
import { apiError, apiValidationError } from "../transport";
import type { WorkerApp } from "../index";
import type { WorkerEnv } from "../types";

const ACCESS_COOKIE = "__Host-dd-access";
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

type ReadDateResult = { date: string } | { error: string };

function parseDate(value: string, field: string): ReadDateResult {
  const match = DATE_PATTERN.exec(value);
  if (!match) return { error: `Niepoprawny format daty w polu ${field}.` };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (year === 0 || !daysInMonth || day < 1 || day > daysInMonth)
    return { error: `Niepoprawna data w polu ${field}.` };

  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
  if (value > today) return { error: `Data w polu ${field} nie może być przyszła.` };
  return { date: value };
}

function readAccessCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== ACCESS_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function sessionRequired(c: Context<WorkerEnv>) {
  return apiError(c, 401, "SESSION_REQUIRED", "Sesja wygasła. Zaloguj się ponownie.");
}

const privateClient = authenticatedClient;

function isReadDate(value: string | undefined, field: string, c: Context<WorkerEnv>) {
  if (value === undefined) return { date: undefined } as const;
  const result = parseDate(value, field);
  if ("error" in result) return { response: apiValidationError(c, field, result.error) } as const;
  return { date: result.date } as const;
}

async function getDay(c: Context<WorkerEnv>): Promise<Response> {
  const parsedDate = isReadDate(c.req.param("date"), "date", c);
  if ("response" in parsedDate) return parsedDate.response;

  const token = readAccessCookie(c.req.raw);
  if (!token) return sessionRequired(c);

  try {
    const result = await privateClient(c, token);
    if (result.kind === "unauthorized") return sessionRequired(c);
    if (result.kind === "unavailable")
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa dziennika jest chwilowo niedostępna.");

    const { data, error } = await result.client
      .schema("api")
      .rpc("get_day", { p_date: parsedDate.date });
    if (error) {
      if (error.code === "22023")
        return apiValidationError(c, "date", "Nie można odczytać tej daty.");
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa dziennika jest chwilowo niedostępna.");
    }
    if (!data) return apiError(c, 403, "FORBIDDEN", "To konto nie ma dostępu do dziennika.");
    return c.json(data, 200);
  } catch {
    return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa dziennika jest chwilowo niedostępna.");
  }
}

async function getGoals(c: Context<WorkerEnv>): Promise<Response> {
  const suppliedDate = c.req.query("date");
  const parsedDate = isReadDate(suppliedDate, "date", c);
  if ("response" in parsedDate) return parsedDate.response;

  const token = readAccessCookie(c.req.raw);
  if (!token) return sessionRequired(c);

  try {
    const result = await privateClient(c, token);
    if (result.kind === "unauthorized") return sessionRequired(c);
    if (result.kind === "unavailable")
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa celów jest chwilowo niedostępna.");

    const args = parsedDate.date ? { p_date: parsedDate.date } : {};
    const { data, error } = await result.client.schema("api").rpc("get_goals", args);
    if (error) {
      if (error.code === "22023")
        return apiValidationError(c, "date", "Nie można odczytać tej daty.");
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa celów jest chwilowo niedostępna.");
    }
    if (!data) return apiError(c, 403, "FORBIDDEN", "To konto nie ma dostępu do dziennika.");
    return c.json(data, 200);
  } catch {
    return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa celów jest chwilowo niedostępna.");
  }
}

export function registerDayReadRoutes(app: WorkerApp): void {
  app.get("/api/v1/days/:date", getDay);
  app.get("/api/v1/goals", getGoals);
}
