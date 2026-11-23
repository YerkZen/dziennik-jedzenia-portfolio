import { checkRateLimit } from "../rate-limit";
import type { MiddlewareHandler } from "hono";
import { authenticatedClient, readAccessCookie } from "../api/products";
import { apiError } from "../transport";
import type { WorkerEnv } from "../types";

const routes: [RegExp, readonly string[]][] = [
  [/^\/api\/v1\/statistics$/, ["GET"]],
  [/^\/api\/v1\/weight-entries\/[^/]+$/, ["PUT", "DELETE"]],
  [/^\/api\/v1\/(products|meal-templates|diary-meals)$/, ["GET", "POST"]],
  [/^\/api\/v1\/(products|meal-templates|diary-meals)\/[^/]+$/, ["GET", "PUT", "DELETE"]],
  [/^\/api\/v1\/days\/[^/]+$/, ["GET"]],
  [/^\/api\/v1\/goals$/, ["GET"]],
  [/^\/api\/v1\/goals\/today$/, ["PUT"]],
  [/^\/api\/v1\/label-readings$/, ["POST"]],
];
/** Session routes perform their own owner checks; unknown routes remain ordinary 404 responses. */
export const requireDomainOwner: MiddlewareHandler<WorkerEnv> = async (c, next) => {
  if (!routes.some(([path, methods]) => path.test(c.req.path) && methods.includes(c.req.method)))
    return next();
  const token = readAccessCookie(c.req.raw);
  if (!token) return apiError(c, 401, "SESSION_REQUIRED", "Sesja wygasła. Zaloguj się ponownie.");
  try {
    const authenticated = await authenticatedClient(c, token);
    if (authenticated.kind === "unauthorized")
      return apiError(c, 401, "SESSION_REQUIRED", "Sesja wygasła. Zaloguj się ponownie.");
    if (authenticated.kind === "unavailable")
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa logowania jest chwilowo niedostępna.");
    const { data, error } = await authenticated.client.schema("api").rpc("get_owner");
    if (error)
      return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa logowania jest chwilowo niedostępna.");
    const owner = (Array.isArray(data) ? data[0] : data) as {
      owner_id?: unknown;
      email?: unknown;
      timezone?: unknown;
    } | null;
    if (
      !owner ||
      typeof owner.owner_id !== "string" ||
      typeof owner.email !== "string" ||
      owner.timezone !== "Europe/Warsaw"
    )
      return apiError(c, 403, "FORBIDDEN", "To konto nie ma dostępu do dziennika.");
    const blocked = await checkRateLimit(c, "API_RATE_LIMITER", "api", owner.owner_id);
    if (blocked) return blocked;
    if (c.req.path === "/api/v1/label-readings") {
      const ocrBlocked = await checkRateLimit(c, "OCR_RATE_LIMITER", "ocr", owner.owner_id);
      if (ocrBlocked) return ocrBlocked;
    }
    c.set("ownerVerified", true);
    return next();
  } catch {
    return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa logowania jest chwilowo niedostępna.");
  }
};
