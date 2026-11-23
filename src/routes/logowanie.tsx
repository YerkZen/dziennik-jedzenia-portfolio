import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Leaf, LockKeyhole } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Btn, Card, Field } from "@/components/app/ui";
import { useAuth, asPrivateRoute } from "@/lib/auth/context";

export const Route = createFileRoute("/logowanie")({
  validateSearch: (search: Record<string, unknown>) => {
    const raw = search["redirect"];
    return typeof raw === "string" ? { redirect: asPrivateRoute(raw) } : {};
  },
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { manager, snapshot } = useAuth();
  const { redirect } = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (snapshot.status === "authenticated") void navigate({ to: redirect ?? "/", replace: true });
  }, [navigate, redirect, snapshot.status]);

  useEffect(() => {
    if (snapshot.logoutPending && navigator.onLine) void manager.handleOnline();
  }, [manager, snapshot.logoutPending]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    const result = await manager.login(email.trim(), password);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message ?? "Logowanie jest chwilowo niedostępne.");
      return;
    }
    setPassword("");
    void navigate({ to: redirect ?? "/", replace: true });
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md animate-rise">
        <div className="mb-7 flex items-center justify-center gap-3">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary text-primary-foreground">
            <Leaf className="h-6 w-6" aria-hidden="true" />
          </span>
          <span className="font-display text-2xl font-semibold">Dziennik Jedzenia</span>
        </div>

        <Card className="p-6 sm:p-8">
          <div className="mb-6 text-center">
            <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl bg-primary-soft text-primary">
              <LockKeyhole className="h-5 w-5" aria-hidden="true" />
            </span>
            <h1 className="font-display text-2xl font-semibold">Zaloguj się</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Dostęp jest przeznaczony dla przygotowanego właściciela dziennika.
            </p>
          </div>

          {snapshot.logoutPending && (
            <p role="status" className="mb-4 rounded-xl bg-muted p-3 text-sm text-muted-foreground">
              Dane na tym urządzeniu zostały wyczyszczone. Wylogowanie serwera oczekuje na
              połączenie; prywatne odczyty pozostają zablokowane.
            </p>
          )}

          <form onSubmit={submit} className="space-y-4" noValidate>
            <Field
              label="E-mail"
              type="email"
              autoComplete="username"
              inputMode="email"
              required
              maxLength={320}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={submitting}
            />
            <Field
              label="Hasło"
              type="password"
              autoComplete="current-password"
              required
              maxLength={4096}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
            />
            {error && (
              <p
                role="alert"
                className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive-strong"
              >
                {error}
              </p>
            )}
            {snapshot.status === "unavailable" && !error && (
              <p role="status" className="text-sm text-muted-foreground">
                Nie udało się potwierdzić sesji. Sprawdź połączenie i zaloguj się ponownie.
              </p>
            )}
            <Btn
              type="submit"
              size="lg"
              className="w-full"
              disabled={submitting || !email || !password}
            >
              {submitting ? "Logowanie…" : "Zaloguj się"}
            </Btn>
          </form>
        </Card>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Odzyskanie dostępu wymaga potwierdzenia właściciela projektu. Aplikacja nie udostępnia
          publicznego resetu hasła.
        </p>
      </div>
    </main>
  );
}
