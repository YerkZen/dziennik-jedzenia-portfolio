import { clearPrivateDrafts } from "./private-drafts";

export type SessionStatus = "checking" | "authenticated" | "anonymous" | "unavailable";

export interface OwnerSession {
  owner_id: string;
  email: string;
  timezone: "Europe/Warsaw";
  expires_at: string;
}

export interface SessionSnapshot {
  status: SessionStatus;
  session?: OwnerSession;
  logoutPending?: boolean;
}

type Listener = (snapshot: SessionSnapshot) => void;
interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}
type SessionChannel = Pick<BroadcastChannel, "postMessage" | "close"> & {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
};
type SessionMessage = { type: "logout" | "session-changed" };
type PrivateCleanup = () => void;

interface SessionManagerOptions {
  fetcher?: typeof fetch;
  isOnline?: () => boolean;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  lockManager?: LockManagerLike | null;
  channelFactory?: (() => SessionChannel | null) | null;
}

const SESSION_PATH = "/api/v1/session";
const REFRESH_PATH = `${SESSION_PATH}/refresh`;
const LOGOUT_PENDING_KEY = "dziennik.logout-pending";
const SESSION_LOCK = "dziennik-session-rotation-v1";
const SESSION_CHANNEL = "dziennik-session-v1";
const REQUEST_HEADER = "DziennikJedzenia";

const sessionShape = (value: unknown): OwnerSession | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate["owner_id"] !== "string" ||
    typeof candidate["email"] !== "string" ||
    candidate["timezone"] !== "Europe/Warsaw" ||
    typeof candidate["expires_at"] !== "string" ||
    !Number.isFinite(Date.parse(candidate["expires_at"]))
  )
    return null;
  return {
    owner_id: candidate["owner_id"],
    email: candidate["email"],
    timezone: "Europe/Warsaw",
    expires_at: candidate["expires_at"],
  };
};

function browserStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function browserLocks(): LockManagerLike | null {
  try {
    return typeof navigator === "undefined"
      ? null
      : ((navigator.locks ?? null) as unknown as LockManagerLike | null);
  } catch {
    return null;
  }
}

function browserChannel(): SessionChannel | null {
  try {
    return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(SESSION_CHANNEL);
  } catch {
    return null;
  }
}

function browserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine;
}

function isMessage(value: unknown): value is SessionMessage {
  return (
    !!value &&
    typeof value === "object" &&
    "type" in value &&
    ((value as { type?: unknown }).type === "logout" ||
      (value as { type?: unknown }).type === "session-changed")
  );
}

export class SessionManager {
  private snapshot: SessionSnapshot = { status: "checking" };
  private listeners = new Set<Listener>();
  private cleanups = new Set<PrivateCleanup>();
  private readonly fetcher: typeof fetch;
  private readonly isOnline: () => boolean;
  private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  private readonly locks: LockManagerLike | null;
  private readonly channel: SessionChannel | null;
  private generation = 0;
  private logoutVersion = 0;
  private initialization: Promise<void> | null = null;
  private refreshInFlight: Promise<boolean> | null = null;
  private readonly storageListener = (event: StorageEvent) => {
    if (event.key !== LOGOUT_PENDING_KEY || event.newValue !== "1") return;
    this.logoutVersion += 1;
    this.generation += 1;
    this.clearPrivateState(true);
    this.setSnapshot({ status: "anonymous", logoutPending: true });
  };

  constructor(options: SessionManagerOptions = {}) {
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
    this.isOnline = options.isOnline ?? browserOnline;
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.locks = options.lockManager === undefined ? browserLocks() : options.lockManager;
    this.channel =
      options.channelFactory === undefined
        ? browserChannel()
        : options.channelFactory === null
          ? null
          : options.channelFactory();
    if (this.channel) {
      this.channel.onmessage = (event) => {
        if (!isMessage(event.data)) return;
        if (event.data.type === "logout") {
          this.logoutVersion += 1;
          this.generation += 1;
          this.clearPrivateState(true);
          this.setSnapshot({ status: "anonymous", logoutPending: this.hasPendingLogout() });
        } else if (!this.hasPendingLogout()) {
          void this.checkSession();
        }
      };
    }
    if (typeof window !== "undefined") window.addEventListener("storage", this.storageListener);
  }

  getSnapshot = (): SessionSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  registerPrivateCleanup(cleanup: PrivateCleanup): () => void {
    this.cleanups.add(cleanup);
    return () => this.cleanups.delete(cleanup);
  }

  canAccessPrivate(): boolean {
    return this.snapshot.status === "authenticated" && !this.hasPendingLogout();
  }

  async initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = this.initializeSession();
    return this.initialization;
  }

  async login(email: string, password: string): Promise<{ ok: boolean; message?: string }> {
    if (!this.isOnline()) return { ok: false, message: "Brak połączenia z internetem." };
    if (this.hasPendingLogout() && !(await this.retryPendingLogout()))
      return {
        ok: false,
        message: "Nie udało się dokończyć wylogowania. Spróbuj ponownie po chwili.",
      };

    const generation = ++this.generation;
    this.setSnapshot({ status: "checking" });
    try {
      const response = await this.request(SESSION_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!this.isCurrent(generation))
        return { ok: false, message: "Sesja uległa zmianie. Zaloguj się ponownie." };
      if (response.status === 401) return this.loginFailure("Nieprawidłowy e-mail lub hasło.");
      if (!response.ok) return this.loginFailure("Logowanie jest chwilowo niedostępne.");
      const session = sessionShape(await this.readJson(response));
      if (!session) return this.loginFailure("Nie udało się potwierdzić sesji. Spróbuj ponownie.");
      this.acceptSession(session, generation);
      this.channel?.postMessage({ type: "session-changed" } satisfies SessionMessage);
      return { ok: true };
    } catch {
      return this.loginFailure("Logowanie jest chwilowo niedostępne.");
    }
  }

  async logout(): Promise<{ serverConfirmed: boolean }> {
    this.logoutVersion += 1;
    this.generation += 1;
    this.clearPrivateState(true);
    this.setLogoutPending();
    this.setSnapshot({ status: "anonymous", logoutPending: true });
    this.channel?.postMessage({ type: "logout" } satisfies SessionMessage);

    if (!this.isOnline()) return { serverConfirmed: false };
    const { value } = await this.withSessionLock(async () => this.sendLogout());
    return { serverConfirmed: value };
  }

  async refreshSession(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const generation = this.generation;
    const logoutVersion = this.logoutVersion;
    const operation = this.withSessionLock(async (locked) => {
      if (!this.isCurrent(generation) || !this.isOnline()) return false;

      const current = await this.request(SESSION_PATH);
      if (!this.isCurrent(generation)) return false;
      if (current.ok) {
        const session = sessionShape(await this.readJson(current));
        return session ? this.acceptSession(session, generation) : this.markUnavailable(generation);
      }
      if (current.status !== 401) return this.markUnavailable(generation);

      let refreshed: Response;
      try {
        refreshed = await this.request(REFRESH_PATH, { method: "POST" });
      } catch {
        if (this.isCurrent(generation)) this.markUnavailable(generation);
        return false;
      }

      if (
        !this.isCurrent(generation) ||
        this.hasPendingLogout() ||
        logoutVersion !== this.logoutVersion
      ) {
        if (!locked && logoutVersion !== this.logoutVersion) {
          this.setLogoutPending();
          await this.sendLogout();
        }
        return false;
      }
      if (refreshed.status === 401) {
        this.clearPrivateState(false);
        this.setSnapshot({ status: "anonymous" });
        return false;
      }
      if (!refreshed.ok) return this.markUnavailable(generation);
      const session = sessionShape(await this.readJson(refreshed));
      if (!session) return this.markUnavailable(generation);
      return this.acceptSession(session, generation);
    });

    this.refreshInFlight = operation
      .then(({ value }) => value)
      .finally(() => {
        this.refreshInFlight = null;
      });
    return this.refreshInFlight;
  }

  async handleOnline(): Promise<boolean> {
    if (!this.hasPendingLogout()) return true;
    return this.retryPendingLogout();
  }

  async fetchPrivate(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.canAccessPrivate()) return this.sessionRequiredResponse();
    let response: Response;
    try {
      response = await this.request(path, init);
    } catch {
      return new Response(JSON.stringify({ code: "SERVICE_UNAVAILABLE" }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    if (response.status !== 401) return response;
    if (!(await this.refreshSession()) || !this.canAccessPrivate())
      return this.sessionRequiredResponse();
    try {
      return await this.request(path, init);
    } catch {
      return new Response(JSON.stringify({ code: "SERVICE_UNAVAILABLE" }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
  }

  close(): void {
    this.channel?.close();
    if (typeof window !== "undefined") window.removeEventListener("storage", this.storageListener);
  }

  private async initializeSession(): Promise<void> {
    const generation = this.generation;
    if (this.hasPendingLogout()) {
      this.clearPrivateState(true);
      this.setSnapshot({ status: "anonymous", logoutPending: true });
      if (this.isOnline()) await this.retryPendingLogout();
      return;
    }
    await this.checkSession(generation);
  }

  private async checkSession(generation = this.generation): Promise<void> {
    if (!this.isCurrent(generation) || this.hasPendingLogout()) return;
    try {
      const response = await this.request(SESSION_PATH);
      if (!this.isCurrent(generation)) return;
      if (response.ok) {
        const session = sessionShape(await this.readJson(response));
        if (session) this.acceptSession(session, generation);
        else this.markUnavailable(generation);
        return;
      }
      if (response.status === 401) {
        const refreshed = await this.refreshSession();
        if (!refreshed && this.snapshot.status === "checking")
          this.setSnapshot({ status: "anonymous" });
        return;
      }
      this.markUnavailable(generation);
    } catch {
      this.markUnavailable(generation);
    }
  }

  private acceptSession(session: OwnerSession, generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    clearPrivateDrafts(session.owner_id);
    this.setSnapshot({ status: "authenticated", session });
    return true;
  }

  private markUnavailable(generation: number): false {
    if (this.isCurrent(generation)) {
      this.clearPrivateState(false);
      this.setSnapshot({ status: "unavailable" });
    }
    return false;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && !this.hasPendingLogout();
  }

  private setSnapshot(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private clearPrivateState(discardDrafts: boolean): void {
    for (const cleanup of this.cleanups) cleanup();
    if (discardDrafts) clearPrivateDrafts();
  }

  private hasPendingLogout(): boolean {
    try {
      return this.storage?.getItem(LOGOUT_PENDING_KEY) === "1";
    } catch {
      return false;
    }
  }

  private setLogoutPending(): void {
    try {
      this.storage?.setItem(LOGOUT_PENDING_KEY, "1");
    } catch {
      // The in-memory anonymous state still blocks private reads in this tab.
    }
  }

  private clearLogoutPending(): void {
    try {
      this.storage?.removeItem(LOGOUT_PENDING_KEY);
    } catch {
      // Keep the browser session closed even when storage is unavailable.
    }
  }

  private async retryPendingLogout(): Promise<boolean> {
    if (!this.hasPendingLogout()) return true;
    if (!this.isOnline()) return false;
    const { value } = await this.withSessionLock(async () => {
      if (!this.hasPendingLogout()) return true;
      return this.sendLogout();
    });
    return value;
  }

  private async sendLogout(): Promise<boolean> {
    try {
      const response = await this.request(SESSION_PATH, { method: "DELETE" });
      if (!response.ok) return false;
      this.clearLogoutPending();
      if (this.snapshot.status === "anonymous" && this.snapshot.logoutPending)
        this.setSnapshot({ status: "anonymous" });
      return true;
    } catch {
      return false;
    }
  }

  private sessionRequiredResponse(): Response {
    return new Response(JSON.stringify({ code: "SESSION_REQUIRED" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  private async loginFailure(message: string): Promise<{ ok: false; message: string }> {
    this.setSnapshot({ status: "anonymous" });
    return { ok: false, message };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.method && init.method !== "GET") headers.set("X-Requested-With", REQUEST_HEADER);
    return this.fetcher(path, {
      ...init,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private async withSessionLock<T>(
    operation: (locked: boolean) => Promise<T>,
  ): Promise<{ value: T; locked: boolean }> {
    if (!this.locks) return { value: await operation(false), locked: false };
    return {
      value: await this.locks.request(SESSION_LOCK, () => operation(true)),
      locked: true,
    };
  }
}
