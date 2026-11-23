import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
const origin = "https://localhost:5173";
describe("Statistics routes in workerd", () => {
  it("protects all three registered operations without a session", async () => {
    for (const [path, method] of [
      ["/statistics?from=2026-01-01&to=2026-01-01", "GET"],
      ["/weight-entries/2026-01-01", "PUT"],
      ["/weight-entries/2026-01-01", "DELETE"],
    ] as const) {
      const response = await exports.default.fetch(`${origin}/api/v1${path}`, {
        method,
        headers: {
          Origin: origin,
          "X-Requested-With": "DziennikJedzenia",
          "Content-Type": "application/json",
        },
        body: method === "PUT" ? JSON.stringify({ weight_kg: "72.35" }) : null,
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});
