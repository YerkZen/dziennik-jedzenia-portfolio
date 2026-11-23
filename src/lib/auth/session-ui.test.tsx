import { fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRouter } from "@/router";

const session = {
  owner_id: "31c85024-5a43-4f8e-a1b5-3fcdf205ef4e",
  email: "owner@example.test",
  timezone: "Europe/Warsaw",
  expires_at: "2026-10-27T12:00:00.000Z",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(
  handler: (url: string, method: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init?.method ?? "GET", init),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("session screens", () => {
  it("routes direct private navigation to the styled login screen", async () => {
    window.history.replaceState({}, "", "/produkty");
    installFetch(() => jsonResponse(401, { code: "SESSION_REQUIRED" }));

    render(createElement(RouterProvider, { router: getRouter() }));

    expect(await screen.findByRole("heading", { name: "Zaloguj się" })).toBeInTheDocument();
    expect(screen.getByLabelText("E-mail")).toBeInTheDocument();
    expect(screen.getByLabelText("Hasło")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Główna nawigacja" })).not.toBeInTheDocument();
  });

  it("logs in through the BFF and returns to the requested route", async () => {
    window.history.replaceState({}, "", "/produkty");
    installFetch((url, method, init) => {
      if (url.endsWith("/api/v1/session") && method === "POST") return jsonResponse(200, session);
      if (url.endsWith("/api/v1/session/refresh"))
        return jsonResponse(401, { code: "SESSION_REQUIRED" });
      if (url.endsWith("/api/v1/session")) return jsonResponse(401, { code: "SESSION_REQUIRED" });
      throw new Error(`Unexpected request: ${method} ${url} ${String(init?.body ?? "")}`);
    });

    render(createElement(RouterProvider, { router: getRouter() }));
    await screen.findByRole("heading", { name: "Zaloguj się" });
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "owner@example.test" } });
    fireEvent.change(screen.getByLabelText("Hasło"), { target: { value: "local-test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Zaloguj się" }));

    expect(await screen.findByRole("heading", { name: "Produkty" })).toBeInTheDocument();
  });

  it("logs out from the profile and returns to login", async () => {
    window.history.replaceState({}, "", "/profil");
    const fetcher = installFetch((url, method) => {
      if (url.endsWith("/api/v1/session") && method === "DELETE")
        return new Response(null, { status: 204 });
      return jsonResponse(200, session);
    });

    render(createElement(RouterProvider, { router: getRouter() }));
    await screen.findByRole("heading", { name: "Profil" });
    fireEvent.click(screen.getByRole("button", { name: "Wyloguj" }));

    expect(await screen.findByRole("heading", { name: "Zaloguj się" })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/session",
      expect.objectContaining({ method: "DELETE", credentials: "same-origin", cache: "no-store" }),
    );
  });
});
