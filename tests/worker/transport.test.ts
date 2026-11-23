import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const apiUrl = "https://localhost:5173/api/v1/missing";
const allowedOrigin = "https://localhost:5173";

describe("API transport (workerd)", () => {
  it("rejects foreign and missing Origin before a route is reached", async () => {
    for (const origin of ["https://attacker.example", null]) {
      const headers = new Headers({
        "Content-Type": "application/json",
        "X-Requested-With": "DziennikJedzenia",
      });
      if (origin) headers.set("Origin", origin);
      const response = await exports.default.fetch(apiUrl, { method: "POST", headers, body: "{}" });

      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        code: "FORBIDDEN",
        request_id: response.headers.get("x-request-id"),
      });
    }
  });

  it("requires the application request header even for the allowed Origin", async () => {
    const response = await exports.default.fetch(apiUrl, {
      method: "POST",
      headers: {
        Origin: allowedOrigin,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("accepts the original HTTPS Origin only through the verified local dev proxy", async () => {
    const forwarded = await exports.default.fetch(apiUrl, {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        "X-Dev-Verified-HTTPS": "1",
        "X-Requested-With": "DziennikJedzenia",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(forwarded.status).toBe(404);

    const forged = await exports.default.fetch(apiUrl, {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "X-Dev-Verified-HTTPS": "1",
        "X-Requested-With": "DziennikJedzenia",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(forged.status).toBe(403);
  });

  it("accepts only same-origin preflight and approved request headers", async () => {
    const allowed = await exports.default.fetch(apiUrl, {
      method: "OPTIONS",
      headers: {
        Origin: allowedOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, x-requested-with",
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    expect(allowed.headers.get("vary")).toContain("Origin");

    const denied = await exports.default.fetch(apiUrl, {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, x-requested-with",
      },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects malformed and oversized JSON before route dispatch", async () => {
    const headers = {
      Origin: allowedOrigin,
      "X-Requested-With": "DziennikJedzenia",
      "Content-Type": "application/json",
    };
    const malformed = await exports.default.fetch(apiUrl, {
      method: "POST",
      headers,
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "BAD_REQUEST" });

    const oversized = await exports.default.fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "x".repeat(256 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("authenticates label-reading requests before parsing their body", async () => {
    const response = await exports.default.fetch("http://localhost/api/v1/label-readings", {
      method: "POST",
      headers: {
        Origin: allowedOrigin,
        "X-Requested-With": "DziennikJedzenia",
        "Content-Type": "application/json",
      },
      body: "{",
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "SESSION_REQUIRED" });
  });

  it("returns a safe JSON 404 and request metadata", async () => {
    const response = await exports.default.fetch(apiUrl);
    const body = (await response.json()) as { code: string; request_id: string };
    expect(response.status).toBe(404);
    expect(body).toMatchObject({ code: "NOT_FOUND" });
    expect(body.request_id).toBe(response.headers.get("x-request-id"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
  });
});
