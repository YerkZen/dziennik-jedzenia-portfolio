export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds: number | undefined = undefined,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const statisticsListeners = new Set<() => void>();
export function onStatisticsMutation(listener: () => void): () => void {
  statisticsListeners.add(listener);
  return () => {
    statisticsListeners.delete(listener);
  };
}

type PrivateFetch = (path: string, init: RequestInit) => Promise<Response>;
let privateFetch: PrivateFetch | null = null;
export function registerPrivateFetch(transport: PrivateFetch): () => void {
  privateFetch = transport;
  return () => {
    if (privateFetch === transport) privateFetch = null;
  };
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Requested-With", "DziennikJedzenia");
    if (init.body !== undefined && init.body !== null && !(init.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }
  }

  if (
    method !== "GET" &&
    method !== "HEAD" &&
    typeof navigator !== "undefined" &&
    !navigator.onLine
  )
    throw new ApiRequestError("Brak połączenia. Formularz nie został wysłany.", 0, "OFFLINE");

  let response: Response;
  try {
    response = await (privateFetch ?? fetch)(path, {
      ...init,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiRequestError(
      "Brak połączenia. Zmiany nie zostały potwierdzone.",
      0,
      "NETWORK_ERROR",
    );
  }

  const body: unknown =
    response.status === 204 ? undefined : await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      body && typeof body === "object"
        ? (body as { message?: unknown; code?: unknown })
        : undefined;
    throw new ApiRequestError(
      typeof error?.message === "string"
        ? error.message
        : "Nie udało się potwierdzić zapisu. Spróbuj ponownie.",
      response.status,
      typeof error?.code === "string" ? error.code : "REQUEST_FAILED",
      response.status === 429 && /^\d+$/.test(response.headers.get("Retry-After") ?? "")
        ? Math.min(86400, Number(response.headers.get("Retry-After")))
        : undefined,
    );
  }
  if (
    method !== "GET" &&
    method !== "HEAD" &&
    /^\/api\/v1\/(diary-meals|weight-entries)(?:\/|$)/.test(path)
  ) {
    for (const listener of statisticsListeners) listener();
  }
  return body as T;
}
