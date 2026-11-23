// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import app from "../../worker";
import type { WorkerBindings } from "../../worker/types";

const labelProposal = {
  name: "Jogurt naturalny",
  basis_status: "per_100",
  basis_unit: "g",
  kcal_per_100: "62",
  protein_per_100: "4.3",
  fat_per_100: "3.2",
  carbs_per_100: "4.7",
  missing_fields: [],
  warnings: [],
};

function getSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (headers.getSetCookie) return headers.getSetCookie();
  const combined = response.headers.get("set-cookie");
  return combined ? combined.split(/, (?=__Host-dd-)/) : [];
}

const origin = "https://localhost:5173";
const owner = "11111111-1111-4111-8111-111111111111";
const calls: string[] = [];
function fixture() {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      calls.push(path);
      if (path === "/auth/v1/user")
        return Response.json({ id: owner, email: "owner@example.test" });
      if (path === "/rest/v1/rpc/get_owner")
        return Response.json([
          { owner_id: owner, email: "owner@example.test", timezone: "Europe/Warsaw" },
        ]);
      if (path === "/rest/v1/rpc/get_day") return Response.json({ date: "2024-05-11" });
      return Response.json({ message: "Rejected fixture credentials" }, { status: 401 });
    }),
  );
}
function bindings(extra: Record<string, unknown>): WorkerBindings {
  return {
    APP_ORIGIN: origin,
    SUPABASE_URL: "https://supabase.fixture.test",
    SUPABASE_PUBLISHABLE_KEY: "fixture-publishable-key",
    ...extra,
  } as WorkerBindings;
}
async function request(path: string, env: WorkerBindings, method = "GET", body?: BodyInit) {
  const headers = new Headers({
    Origin: origin,
    "X-Requested-With": "DziennikJedzenia",
    "CF-Connecting-IP": "192.0.2.11",
    Cookie: "__Host-dd-access=fixture-access-token; __Host-dd-refresh=private-refresh-token",
  });
  if (body && !(body instanceof FormData)) headers.set("Content-Type", "application/json");
  return app.fetch(new Request(origin + path, { method, headers, ...(body ? { body } : {}) }), env);
}
afterEach(() => vi.unstubAllGlobals());
it.each(["/api/v1/session", "/api/v1/session/refresh"])(
  "rejects an exhausted %s limit before calling Auth",
  async (path) => {
    fixture();
    const limit = vi.fn(async () => ({ success: false }));
    const response = await request(
      path,
      bindings({ LOGIN_RATE_LIMITER: { limit }, REFRESH_RATE_LIMITER: { limit } }),
      "POST",
      JSON.stringify({ email: "owner@example.test", password: "private-fixture-password" }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual([]);
    expect(limit.mock.calls[0]).toEqual([
      { key: expect.stringMatching(/^dziennik:(login|refresh):[a-f0-9]{64}$/) },
    ]);
  },
);
it("blocks an exhausted owner limit before the domain RPC", async () => {
  fixture();
  const limit = vi.fn(async () => ({ success: false }));
  const response = await request(
    "/api/v1/days/2024-05-11",
    bindings({ API_RATE_LIMITER: { limit } }),
  );
  expect(response.status).toBe(429);
  expect(calls).not.toContain("/rest/v1/rpc/get_day");
  expect(limit).toHaveBeenCalledTimes(1);
});
it("blocks exhausted OCR before invoking the model", async () => {
  fixture();
  const image = new PNG({ width: 1, height: 1 });
  image.data.fill(0);
  const form = new FormData();
  form.append(
    "image",
    new Blob([new Uint8Array(PNG.sync.write(image))], { type: "image/png" }),
    "fixture.png",
  );
  const { warnings: _warnings, missing_fields: _missing, ...model } = labelProposal;
  const run = vi.fn(async () => ({
    choices: [{ message: { content: JSON.stringify(model) }, finish_reason: "stop" }],
  }));
  const positive = await request(
    "/api/v1/label-readings",
    bindings({
      API_RATE_LIMITER: { limit: async () => ({ success: true }) },
      OCR_RATE_LIMITER: { limit: async () => ({ success: true }) },
      AI: { run },
    }),
    "POST",
    form,
  );
  expect(positive.status).toBe(200);
  run.mockClear();
  const response = await request(
    "/api/v1/label-readings",
    bindings({
      API_RATE_LIMITER: { limit: async () => ({ success: true }) },
      OCR_RATE_LIMITER: { limit: async () => ({ success: false }) },
      AI: { run },
    }),
    "POST",
    form,
  );
  expect(response.status).toBe(429);
  expect(run).not.toHaveBeenCalled();
});
it("fails closed when required rate bindings are missing or unavailable", async () => {
  fixture();
  const missing = await request(
    "/api/v1/session",
    bindings({ REQUIRE_RATE_LIMITS: "true" }),
    "POST",
    JSON.stringify({ email: "owner@example.test", password: "private-fixture-password" }),
  );
  expect(missing.status).toBe(503);
  expect(calls).toEqual([]);
  const failed = await request(
    "/api/v1/days/2024-05-11",
    bindings({
      API_RATE_LIMITER: {
        limit: async () => {
          throw new Error("local limiter unavailable");
        },
      },
    }),
  );
  expect(failed.status).toBe(503);
  expect(calls).not.toContain("/rest/v1/rpc/get_day");
});

it("keeps rotated session cookies when the verified session limit rejects a refresh", async () => {
  const token = (nonce: string) =>
    `fixture.${Buffer.from(JSON.stringify({ session_id: "stable-session", nonce, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
  const first = token("first"),
    second = token("second");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/auth/v1/token")
        return Response.json({
          access_token: first,
          refresh_token: "rotated-private-refresh",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: owner, email: "owner@example.test" },
        });
      if (path === "/auth/v1/user")
        return Response.json({ id: owner, email: "owner@example.test" });
      if (path === "/rest/v1/rpc/get_owner")
        return Response.json([
          { owner_id: owner, email: "owner@example.test", timezone: "Europe/Warsaw" },
        ]);
      throw new Error("Unexpected fixture request");
    }),
  );
  let attempts = 0;
  const response = await request(
    "/api/v1/session/refresh",
    bindings({ REFRESH_RATE_LIMITER: { limit: async () => ({ success: ++attempts === 1 }) } }),
    "POST",
    "{}",
  );
  expect(response.status).toBe(429);
  expect(getSetCookies(response)).toHaveLength(2);
  expect(
    getSetCookies(response).every(
      (cookie) => cookie.includes("HttpOnly") && cookie.includes("Secure"),
    ),
  ).toBe(true);
  const { verifiedSessionIdentity } = await import("../../worker/rate-limit");
  expect(verifiedSessionIdentity(first, owner)).toBe(verifiedSessionIdentity(second, owner));
  expect(verifiedSessionIdentity(first, owner)).toBe("session:stable-session");
});
