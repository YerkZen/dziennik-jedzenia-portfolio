import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPrivateDrafts,
  hasPrivateDrafts,
  readPrivateDraft,
  savePrivateDraft,
} from "@/lib/auth/private-drafts";
import {
  clearPrivateObjectUrls,
  createPrivateObjectUrl,
  privateObjectUrlCount,
} from "@/lib/auth/private-object-urls";
import { SessionManager } from "@/lib/auth/session-manager";

const ownerSession = {
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

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  entries() {
    return [...this.values.entries()];
  }
}

function isolatedOptions(fetcher: typeof fetch, storage = new MemoryStorage()) {
  return {
    fetcher,
    storage,
    lockManager: null,
    channelFactory: null,
    isOnline: () => true,
  } as const;
}

afterEach(() => {
  clearPrivateDrafts();
  clearPrivateObjectUrls();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SessionManager", () => {
  it("preserves a RAM draft after expiry and removes it after explicit logout", async () => {
    let checks = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      if (String(input).endsWith("/api/v1/session") && method === "GET") {
        checks += 1;
        return checks === 1
          ? jsonResponse(200, ownerSession)
          : jsonResponse(401, { code: "SESSION_REQUIRED" });
      }
      if (String(input).endsWith("/api/v1/session") && method === "POST")
        return jsonResponse(200, ownerSession);
      if (String(input).endsWith("/api/v1/session/refresh"))
        return jsonResponse(401, { code: "SESSION_REQUIRED" });
      if (String(input).endsWith("/api/v1/session") && method === "DELETE")
        return new Response(null, { status: 204 });
      throw new Error(`Unexpected request: ${String(input)}`);
    };
    const manager = new SessionManager(isolatedOptions(fetcher));

    await manager.initialize();
    savePrivateDraft("product-form", ownerSession.owner_id, { name: "Ryż" });
    expect(await manager.refreshSession()).toBe(false);
    expect(readPrivateDraft("product-form", ownerSession.owner_id)).toEqual({ name: "Ryż" });
    expect((await manager.login("owner@example.test", "local-password")).ok).toBe(true);
    expect(readPrivateDraft("product-form", ownerSession.owner_id)).toEqual({ name: "Ryż" });

    await manager.logout();
    expect(hasPrivateDrafts()).toBe(false);
    expect(manager.getSnapshot().status).toBe("anonymous");
    manager.close();
  });

  it("blocks private requests while offline logout is pending and stores no private data", async () => {
    const storage = new MemoryStorage();
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return jsonResponse(200, ownerSession);
    };
    let online = true;
    const manager = new SessionManager({
      ...isolatedOptions(fetcher, storage),
      isOnline: () => online,
    });
    await manager.initialize();
    savePrivateDraft("meal-form", ownerSession.owner_id, { note: "usuń" });

    online = false;
    const result = await manager.logout();
    const beforeBlockedRead = calls.length;
    const privateResponse = await manager.fetchPrivate("/api/v1/days/2026-10-26");

    expect(result.serverConfirmed).toBe(false);
    expect(manager.canAccessPrivate()).toBe(false);
    expect(manager.getSnapshot()).toMatchObject({ status: "anonymous", logoutPending: true });
    expect(privateResponse.status).toBe(401);
    expect(calls).toHaveLength(beforeBlockedRead);
    expect(storage.entries()).toEqual([["dziennik.logout-pending", "1"]]);
    expect(hasPrivateDrafts()).toBe(false);

    online = true;
    expect(await manager.handleOnline()).toBe(true);
    expect(manager.getSnapshot()).toEqual({ status: "anonymous" });
    expect(storage.entries()).toEqual([]);
    expect(calls.at(-1)).toBe("DELETE /api/v1/session");
    manager.close();
  });

  it("uses a Web Lock and rechecks the session before rotating refresh cookies", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return jsonResponse(200, ownerSession);
    };
    const lockNames: string[] = [];
    const lockManager = {
      async request<T>(name: string, callback: () => Promise<T>): Promise<T> {
        lockNames.push(name);
        return callback();
      },
    };
    const manager = new SessionManager({
      ...isolatedOptions(fetcher),
      lockManager,
    });
    await manager.initialize();
    expect(await manager.refreshSession()).toBe(true);

    expect(lockNames).toEqual(["dziennik-session-rotation-v1"]);
    expect(calls).toEqual(["GET /api/v1/session", "GET /api/v1/session"]);
    manager.close();
  });

  it("re-clears the server session if a no-lock refresh response arrives after logout", async () => {
    let sessionChecks = 0;
    let resolveRefresh: ((response: Response) => void) | undefined;
    let signalRefreshStarted: (() => void) | undefined;
    let deleteRequests = 0;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve;
    });
    const fetcher: typeof fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      if (String(input).endsWith("/api/v1/session") && method === "GET") {
        sessionChecks += 1;
        return sessionChecks === 1
          ? jsonResponse(200, ownerSession)
          : jsonResponse(401, { code: "SESSION_REQUIRED" });
      }
      if (String(input).endsWith("/api/v1/session/refresh")) {
        signalRefreshStarted?.();
        return new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        });
      }
      if (String(input).endsWith("/api/v1/session") && method === "DELETE") {
        deleteRequests += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${method} ${String(input)}`);
    };
    const manager = new SessionManager(isolatedOptions(fetcher));
    await manager.initialize();

    const refresh = manager.refreshSession();
    await refreshStarted;
    await manager.logout();
    expect(deleteRequests).toBe(1);
    resolveRefresh?.(jsonResponse(200, ownerSession));
    await refresh;

    expect(manager.getSnapshot().status).toBe("anonymous");
    expect(deleteRequests).toBe(2);
    manager.close();
  });

  it("propagates a logout signal without broadcasting session data", async () => {
    const fetcher: typeof fetch = async () => jsonResponse(200, ownerSession);
    const channelState: { onmessage: ((event: MessageEvent<unknown>) => void) | null } = {
      onmessage: null,
    };
    const messages: unknown[] = [];
    const manager = new SessionManager({
      ...isolatedOptions(fetcher),
      channelFactory: () => ({
        postMessage: (message) => messages.push(message),
        close: () => {},
        get onmessage() {
          return channelState.onmessage;
        },
        set onmessage(handler) {
          channelState.onmessage = handler;
        },
      }),
    });
    await manager.initialize();
    savePrivateDraft("form", ownerSession.owner_id, { calories: 400 });

    channelState.onmessage?.({ data: { type: "logout" } } as MessageEvent<unknown>);

    expect(manager.getSnapshot().status).toBe("anonymous");
    expect(manager.canAccessPrivate()).toBe(false);
    expect(hasPrivateDrafts()).toBe(false);
    expect(messages).toEqual([]);
    expect(JSON.stringify(messages)).not.toContain("owner@example.test");
    expect(privateObjectUrlCount()).toBe(0);
    manager.close();
  });

  it("revokes private blob URLs through registered logout cleanup", async () => {
    const createObjectURL = vi.fn(() => "blob:private-image");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const fetcher: typeof fetch = async () => new Response(null, { status: 204 });
    const manager = new SessionManager(isolatedOptions(fetcher));
    manager.registerPrivateCleanup(clearPrivateObjectUrls);
    createPrivateObjectUrl(new Blob(["private image"]));

    expect(privateObjectUrlCount()).toBe(1);
    await manager.logout();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:private-image");
    expect(privateObjectUrlCount()).toBe(0);
    manager.close();
  });
});
