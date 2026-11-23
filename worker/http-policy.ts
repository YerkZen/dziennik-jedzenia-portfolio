import type { MiddlewareHandler } from "hono";
import type { WorkerEnv } from "./types";
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'self'; upgrade-insecure-requests";
function routeTemplate(path: string): string {
  if (
    /^\/api\/v1\/(session(?:\/refresh)?|products|meal-templates|diary-meals|goals(?:\/today)?|label-readings|statistics)$/.test(
      path,
    ) ||
    path === "/api/health"
  )
    return path;
  const aggregate = /^\/api\/v1\/(products|meal-templates|diary-meals)\/[^/]+$/.exec(path);
  if (aggregate) return `/api/v1/${aggregate[1]}/:id`;
  if (/^\/api\/v1\/weight-entries\/[^/]+$/.test(path)) return "/api/v1/weight-entries/:date";
  if (/^\/api\/v1\/days\/[^/]+$/.test(path)) return "/api/v1/days/:date";
  return "/api/*";
}
export const apiHttpPolicy: MiddlewareHandler<WorkerEnv> = async (c, next) => {
  if (c.req.path !== "/api" && !c.req.path.startsWith("/api/")) return next();
  const start = performance.now();
  c.set("requestStartedAt", start);
  c.set("requestId", crypto.randomUUID());
  try {
    if (new URL(c.req.url).protocol === "http:" && c.env?.DEV_ORIGIN_FORWARDING !== "true") {
      const target = new URL(c.req.url);
      target.protocol = "https:";
      c.res = c.redirect(target.toString(), 308);
      return c.res;
    }
    await next();
  } finally {
    c.header("Cache-Control", "no-store");
    const vary = c.res.headers.get("Vary") ?? "";
    if (!vary.split(",").some((value) => value.trim().toLowerCase() === "cookie"))
      c.header("Vary", [vary, "Cookie"].filter(Boolean).join(", "));
    c.header("X-Request-ID", c.get("requestId"));
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    if (new URL(c.req.url).protocol === "https:" && c.env?.DEV_ORIGIN_FORWARDING !== "true")
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (c.env?.LOG_REQUESTS === "true") {
      const method = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"].includes(
        c.req.method,
      )
        ? c.req.method
        : "OTHER";
      console.info(
        JSON.stringify({
          request_id: c.get("requestId"),
          route: `${method} ${routeTemplate(c.req.path)}`,
          status: c.res.status,
          duration_ms: Math.max(0, Math.round((performance.now() - start) * 100) / 100),
        }),
      );
    }
  }
};
