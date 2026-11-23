import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
describe("workerd bootstrap (technical)", () => {
  it("runs the health endpoint inside workerd", async () => {
    const response = await exports.default.fetch("http://localhost/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
  it("returns JSON 404 for unknown API paths, including navigation requests", async () => {
    for (const method of ["GET", "POST"]) {
      const headers = new Headers({
        "Sec-Fetch-Mode": "navigate",
        Origin: "https://localhost:5173",
      });
      if (method === "POST") headers.set("X-Requested-With", "DziennikJedzenia");
      const response = await exports.default.fetch("http://localhost/api/missing", {
        method,
        headers,
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toMatchObject({
        code: "NOT_FOUND",
        request_id: expect.any(String),
      });
    }
  });
});
