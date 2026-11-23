import { safeUpstreamFetch } from "../upstream-fetch";
import { checkRateLimit, verifiedSessionIdentity } from "../rate-limit";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Context } from "hono";
import { apiError } from "../transport";
import type { WorkerApp } from "../index";
import type { WorkerEnv } from "../types";

const ACCESS_COOKIE = "__Host-dd-access";
const REFRESH_COOKIE = "__Host-dd-refresh";
const ACCESS_MAX_AGE_SECONDS = 15 * 60;
const REFRESH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const LoginSchema = z
  .object({
    email: z.string().email().max(320),
    password: z.string().min(1).max(4096),
  })
  .strict();

const RefreshedSessionSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    expires_at: z.number().optional(),
    expires_in: z.number().optional(),
    user: z.object({ email: z.string().email().nullable().optional() }).passthrough(),
  })
  .passthrough();

type OwnerRow = {
  owner_id: string;
  email: string;
  timezone: "Europe/Warsaw";
};

function isServiceRoleKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  const segment = key.split(".")[1];
  if (!segment) return false;
  try {
    const payload = JSON.parse(atob(segment.replaceAll("-", "+").replaceAll("_", "/"))) as {
      role?: string;
    };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

function supabaseClient(c: Context<WorkerEnv>, accessToken?: string) {
  const url = c.env.SUPABASE_URL;
  const key = c.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || isServiceRoleKey(key))
    throw new Error("Supabase client configuration is invalid.");

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      fetch: safeUpstreamFetch,
      ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
    },
  });
}

function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function setSessionCookie(
  c: Context<WorkerEnv>,
  name: string,
  value: string,
  maxAge: number,
): void {
  c.header(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`,
    { append: true },
  );
}

function clearSessionCookie(c: Context<WorkerEnv>, name: string): void {
  c.header("Set-Cookie", `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`, {
    append: true,
  });
}

function clearSessionCookies(c: Context<WorkerEnv>): void {
  clearSessionCookie(c, ACCESS_COOKIE);
  clearSessionCookie(c, REFRESH_COOKIE);
}

function expiresAtFromSession(
  expiresAt: number | undefined,
  expiresIn: number | undefined,
): Date | null {
  const now = Math.floor(Date.now() / 1000);
  const candidate = expiresAt ?? (expiresIn ? now + expiresIn : undefined);
  if (!candidate || !Number.isFinite(candidate) || candidate <= now) return null;
  return new Date(candidate * 1000);
}

function expiresAtFromVerifiedToken(token: string): Date | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = JSON.parse(atob(normalized)) as { exp?: number };
    if (!decoded.exp || !Number.isFinite(decoded.exp) || decoded.exp * 1000 <= Date.now())
      return null;
    return new Date(decoded.exp * 1000);
  } catch {
    return null;
  }
}

async function ownerForToken(c: Context<WorkerEnv>, accessToken: string) {
  const client = supabaseClient(c, accessToken);
  const { data: userResult, error: userError } = await client.auth.getUser(accessToken);
  if (userError || !userResult.user)
    return userError?.status && userError.status >= 500
      ? { kind: "unavailable" as const }
      : { kind: "unauthorized" as const };

  const { data, error } = await client.schema("api").rpc("get_owner");
  if (error) return { kind: "unavailable" as const };

  const owner = (Array.isArray(data) ? data[0] : data) as OwnerRow | null;
  if (
    !owner ||
    typeof owner.owner_id !== "string" ||
    typeof owner.email !== "string" ||
    owner.timezone !== "Europe/Warsaw"
  ) {
    return { kind: "forbidden" as const };
  }
  return { kind: "owner" as const, owner, user: userResult.user };
}

function sessionBody(owner: OwnerRow, email: string, expiresAt: Date) {
  return {
    owner_id: owner.owner_id,
    email,
    timezone: owner.timezone,
    expires_at: expiresAt.toISOString(),
  };
}

function authFailure(c: Context<WorkerEnv>, kind: "unauthorized" | "forbidden" | "unavailable") {
  if (kind === "unauthorized") {
    return apiError(c, 401, "SESSION_REQUIRED", "Nieprawidłowy e-mail lub hasło.");
  }
  if (kind === "forbidden") {
    return apiError(c, 403, "FORBIDDEN", "To konto nie ma dostępu do dziennika.");
  }
  return apiError(c, 503, "SERVICE_UNAVAILABLE", "Usługa logowania jest chwilowo niedostępna.");
}

function sessionRequired(c: Context<WorkerEnv>) {
  return apiError(c, 401, "SESSION_REQUIRED", "Sesja wygasła. Zaloguj się ponownie.");
}

async function createSession(c: Context<WorkerEnv>): Promise<Response> {
  let input: unknown;
  try {
    input = await c.req.json();
  } catch {
    return apiError(c, 400, "BAD_REQUEST", "Treść żądania nie jest poprawnym JSON.");
  }
  const parsed = LoginSchema.safeParse(input);
  if (!parsed.success) return apiError(c, 400, "BAD_REQUEST", "Podaj poprawny e-mail i hasło.");

  try {
    const client = supabaseClient(c);
    const { data, error } = await client.auth.signInWithPassword(parsed.data);
    if (error) {
      return error.status === 400 || error.status === 401
        ? authFailure(c, "unauthorized")
        : authFailure(c, "unavailable");
    }
    const session = data.session;
    if (!session?.access_token || !session.refresh_token) return authFailure(c, "unauthorized");

    const expiry = expiresAtFromSession(session.expires_at, session.expires_in);
    if (!expiry) return authFailure(c, "unauthorized");
    const ownerResult = await ownerForToken(c, session.access_token);
    if (ownerResult.kind !== "owner") return authFailure(c, ownerResult.kind);

    const accessMaxAge = Math.min(
      ACCESS_MAX_AGE_SECONDS,
      Math.max(1, Math.floor((expiry.getTime() - Date.now()) / 1000)),
    );
    setSessionCookie(c, ACCESS_COOKIE, session.access_token, accessMaxAge);
    setSessionCookie(c, REFRESH_COOKIE, session.refresh_token, REFRESH_MAX_AGE_SECONDS);
    return c.json(
      sessionBody(ownerResult.owner, ownerResult.user.email ?? parsed.data.email, expiry),
      200,
    );
  } catch {
    return authFailure(c, "unavailable");
  }
}

async function getSession(c: Context<WorkerEnv>): Promise<Response> {
  const accessToken = readCookie(c.req.raw, ACCESS_COOKIE);
  if (!accessToken) return sessionRequired(c);

  try {
    const result = await ownerForToken(c, accessToken);
    if (result.kind === "unauthorized") return sessionRequired(c);
    if (result.kind !== "owner") return authFailure(c, result.kind);
    const expiry = expiresAtFromVerifiedToken(accessToken);
    if (!expiry) return sessionRequired(c);
    const blocked = await checkRateLimit(c, "API_RATE_LIMITER", "api", result.owner.owner_id);
    if (blocked) return blocked;
    return c.json(sessionBody(result.owner, result.user.email ?? result.owner.email, expiry), 200);
  } catch {
    return authFailure(c, "unavailable");
  }
}

async function refreshSession(c: Context<WorkerEnv>): Promise<Response> {
  const refreshToken = readCookie(c.req.raw, REFRESH_COOKIE);
  if (!refreshToken) {
    clearSessionCookies(c);
    return sessionRequired(c);
  }

  try {
    const refresh = await requestAuthRefresh(c, refreshToken);
    if (refresh.kind === "unavailable") return authFailure(c, "unavailable");
    if (refresh.kind === "unauthorized") {
      clearSessionCookies(c);
      return sessionRequired(c);
    }

    const session = refresh.session;
    const expiry = expiresAtFromSession(session.expires_at, session.expires_in);
    if (!expiry) {
      clearSessionCookies(c);
      return sessionRequired(c);
    }

    const ownerResult = await ownerForToken(c, session.access_token);
    if (ownerResult.kind === "unauthorized") {
      clearSessionCookies(c);
      return sessionRequired(c);
    }
    if (ownerResult.kind !== "owner") {
      if (ownerResult.kind === "forbidden") clearSessionCookies(c);
      return authFailure(c, ownerResult.kind);
    }

    const accessMaxAge = Math.min(
      ACCESS_MAX_AGE_SECONDS,
      Math.max(1, Math.floor((expiry.getTime() - Date.now()) / 1000)),
    );
    setSessionCookie(c, ACCESS_COOKIE, session.access_token, accessMaxAge);
    setSessionCookie(c, REFRESH_COOKIE, session.refresh_token, REFRESH_MAX_AGE_SECONDS);
    // Preserve rotated cookies even when the per-session budget rejects this response.
    const blocked = await checkRateLimit(
      c,
      "REFRESH_RATE_LIMITER",
      "refresh",
      verifiedSessionIdentity(session.access_token, ownerResult.owner.owner_id),
    );
    if (blocked) return blocked;
    return c.json(
      sessionBody(
        ownerResult.owner,
        ownerResult.user.email ?? session.user.email ?? ownerResult.owner.email,
        expiry,
      ),
      200,
    );
  } catch {
    return authFailure(c, "unavailable");
  }
}

type RefreshResult =
  | { kind: "session"; session: z.infer<typeof RefreshedSessionSchema> }
  | { kind: "unauthorized" }
  | { kind: "unavailable" };

async function requestAuthRefresh(
  c: Context<WorkerEnv>,
  refreshToken: string,
): Promise<RefreshResult> {
  const url = c.env.SUPABASE_URL;
  const key = c.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key || isServiceRoleKey(key)) return { kind: "unavailable" };

  let response: Response;
  try {
    response = await fetch(`${url.replace(/\/+$/, "")}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { kind: "unavailable" };
  }

  if (response.status === 400 || response.status === 401) return { kind: "unauthorized" };
  if (!response.ok) return { kind: "unavailable" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "unavailable" };
  }

  const parsed = RefreshedSessionSchema.safeParse(body);
  if (!parsed.success) return { kind: "unavailable" };
  return { kind: "session", session: parsed.data };
}

async function revokeCurrentSession(
  c: Context<WorkerEnv>,
  accessToken: string | null,
  refreshToken: string | null,
): Promise<void> {
  if (!accessToken && !refreshToken) return;

  let sessionToRevoke: { access_token: string; refresh_token: string } | null = null;
  const accessExpiresAt = accessToken ? expiresAtFromVerifiedToken(accessToken) : null;

  if (accessToken && accessExpiresAt && refreshToken) {
    sessionToRevoke = { access_token: accessToken, refresh_token: refreshToken };
  } else if (refreshToken) {
    const refresh = await requestAuthRefresh(c, refreshToken);
    if (refresh.kind === "session") {
      sessionToRevoke = {
        access_token: refresh.session.access_token,
        refresh_token: refresh.session.refresh_token,
      };
    }
  }

  try {
    const client = supabaseClient(c);
    if (sessionToRevoke) {
      const { data, error } = await client.auth.setSession(sessionToRevoke);
      if (!error && data.session) await client.auth.signOut({ scope: "local" });
      return;
    }

    if (accessToken) await client.auth.admin.signOut(accessToken, "local");
  } catch {
    // Local logout is best-effort; the browser must still discard both cookies.
  }
}

async function deleteSession(c: Context<WorkerEnv>): Promise<Response> {
  const accessToken = readCookie(c.req.raw, ACCESS_COOKIE);
  const refreshToken = readCookie(c.req.raw, REFRESH_COOKIE);
  await revokeCurrentSession(c, accessToken, refreshToken);
  clearSessionCookies(c);
  return c.body(null, 204);
}

export function registerSessionRoutes(app: WorkerApp): void {
  app.post("/api/v1/session", createSession);
  app.get("/api/v1/session", getSession);
  app.post("/api/v1/session/refresh", refreshSession);
  app.delete("/api/v1/session", deleteSession);
}
