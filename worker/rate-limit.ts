import type { Context, MiddlewareHandler } from "hono";
import { apiError } from "./transport";
import type { WorkerEnv } from "./types";

type LimiterName =
  "LOGIN_RATE_LIMITER" | "REFRESH_RATE_LIMITER" | "API_RATE_LIMITER" | "OCR_RATE_LIMITER";
/** Binding API and per-location semantics: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ */
export async function checkRateLimit(
  c: Context<WorkerEnv>,
  name: LimiterName,
  scope: string,
  identity: string,
): Promise<Response | null> {
  const binding = c.env?.[name];
  if (!binding)
    return c.env?.REQUIRE_RATE_LIMITS === "true"
      ? apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa jest chwilowo niedostępna.")
      : null;
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const { success } = await binding.limit({ key: `dziennik:${scope}:${hash}` });
    if (success) return null;
    c.header("Retry-After", "60");
    return apiError(c, 429, "RATE_LIMIT", "Zbyt wiele prób. Spróbuj ponownie za chwilę.");
  } catch {
    return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa jest chwilowo niedostępna.");
  }
}
export const limitSessionAttempts: MiddlewareHandler<WorkerEnv> = async (c, next) => {
  if (c.req.method !== "POST") return next();
  const login = c.req.path === "/api/v1/session";
  const refresh = c.req.path === "/api/v1/session/refresh";
  if (!login && !refresh) return next();
  const ip = c.req.header("CF-Connecting-IP") ?? "local-development";
  const blocked = await checkRateLimit(
    c,
    login ? "LOGIN_RATE_LIMITER" : "REFRESH_RATE_LIMITER",
    login ? "login" : "refresh",
    `${refresh ? "ip:" : ""}${ip}`,
  );
  if (blocked) return blocked;
  return next();
};
/** Call only after Auth has verified the new access token. Rotating refresh tokens do not change this key. */
export function verifiedSessionIdentity(token: string, owner: string): string {
  try {
    const payload = JSON.parse(
      atob(token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")),
    ) as { session_id?: unknown };
    if (typeof payload.session_id === "string" && payload.session_id.length <= 255)
      return `session:${payload.session_id}`;
  } catch {
    /* Opaque fixture tokens use the verified owner as a conservative fallback. */
  }
  return `owner:${owner}`;
}
