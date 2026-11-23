/* eslint-disable react-refresh/only-export-components -- context hooks and providers share one module. */
import type { QueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app/AppShell";
import { NutritionProvider } from "@/lib/nutrition/store";
import { discardPrivateDraft, readPrivateDraft, savePrivateDraft } from "./private-drafts";
import { clearPrivateObjectUrls } from "./private-object-urls";
import { registerPrivateFetch, onStatisticsMutation, ApiRequestError } from "@/lib/api/client";
import { SessionManager, type SessionSnapshot } from "./session-manager";

export type PrivateRoutePath = "/" | "/dodaj" | "/historia" | "/produkty" | "/profil" | "/skanuj";

const privateRoutes = new Set<string>([
  "/",
  "/dodaj",
  "/historia",
  "/produkty",
  "/profil",
  "/skanuj",
]);

export function asPrivateRoute(path: string): PrivateRoutePath {
  return privateRoutes.has(path) ? (path as PrivateRoutePath) : "/";
}

interface AuthContextValue {
  manager: SessionManager;
  snapshot: SessionSnapshot;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  queryClient,
  children,
}: {
  queryClient: QueryClient;
  children: ReactNode;
}) {
  const [manager] = useState(() => new SessionManager());
  const snapshot = useSyncExternalStore(
    manager.subscribe,
    manager.getSnapshot,
    manager.getSnapshot,
  );

  useEffect(() => {
    const unregisterFetch = registerPrivateFetch((path, init) => manager.fetchPrivate(path, init));
    const unregisterCleanup = manager.registerPrivateCleanup(() => {
      queryClient.clear();
      clearPrivateObjectUrls();
    });
    const refreshStatistics = () => {
      if (manager.getSnapshot().status !== "authenticated") return;
      void queryClient.refetchQueries({
        queryKey: ["statistics"],
        type: "active",
        predicate: (query) => {
          const error = query.state.error;
          return !(
            error instanceof ApiRequestError &&
            error.status === 429 &&
            Date.now() - query.state.errorUpdatedAt < (error.retryAfterSeconds ?? 0) * 1000
          );
        },
      });
    };
    const unregisterStatistics = onStatisticsMutation(() => {
      if (manager.getSnapshot().status === "authenticated")
        void queryClient.invalidateQueries({ queryKey: ["statistics"] });
    });
    const handleOnline = () => {
      void manager.handleOnline().then(refreshStatistics);
    };
    window.addEventListener("focus", refreshStatistics);
    window.addEventListener("online", handleOnline);
    void manager.initialize();
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("focus", refreshStatistics);
      unregisterStatistics();
      unregisterFetch();
      unregisterCleanup();
      manager.close();
    };
  }, [manager, queryClient]);

  const value = useMemo(() => ({ manager, snapshot }), [manager, snapshot]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}

export function usePrivateDraft<T>(
  key: string,
  initialValue: T,
): [T, (value: T | ((current: T) => T)) => void] {
  const context = useContext(AuthContext);
  const ownerId = context?.snapshot.session?.owner_id;
  const [value, setValue] = useState<T>(() => {
    if (!ownerId) return initialValue;
    return readPrivateDraft<T>(key, ownerId) ?? initialValue;
  });

  useEffect(() => {
    if (ownerId) savePrivateDraft(key, ownerId, value);
  }, [key, ownerId, value]);

  const update = useCallback((next: T | ((current: T) => T)) => {
    setValue((current) =>
      typeof next === "function" ? (next as (current: T) => T)(current) : next,
    );
  }, []);

  return [value, update];
}

export { discardPrivateDraft };

function SessionStatusMessage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <p role="status" className="text-sm text-muted-foreground">
        Sprawdzam sesję…
      </p>
    </div>
  );
}

export function AuthBoundary({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const { snapshot } = useAuth();
  const loginRoute = path === "/logowanie";
  const privatePath = asPrivateRoute(path);

  useEffect(() => {
    if (loginRoute || snapshot.status === "checking" || snapshot.status === "authenticated") return;
    void navigate({
      to: "/logowanie",
      search: { redirect: privatePath },
      replace: true,
    });
  }, [loginRoute, navigate, privatePath, snapshot.status]);

  if (loginRoute) return <>{children}</>;
  if (snapshot.status === "checking") return <SessionStatusMessage />;
  if (snapshot.status !== "authenticated" || !snapshot.session) return <SessionStatusMessage />;

  return <AppShell>{children}</AppShell>;
}

export function SessionDataProvider({ children }: { children: ReactNode }) {
  const { snapshot } = useAuth();
  const key =
    snapshot.status === "authenticated"
      ? (snapshot.session?.owner_id ?? "authenticated")
      : "private-closed";
  return <NutritionProvider key={key}>{children}</NutritionProvider>;
}
