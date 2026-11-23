import { Link, useRouterState } from "@tanstack/react-router";
import { BookOpen, CalendarDays, Leaf, Plus, ScanLine, User, Utensils } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Dzisiaj", icon: CalendarDays },
  { to: "/produkty", label: "Produkty", icon: BookOpen },
  { to: "/dodaj", label: "Dodaj", icon: Plus, primary: true },
  { to: "/historia", label: "Historia", icon: Utensils },
  { to: "/profil", label: "Profil", icon: User },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (to: string) => (to === "/" ? path === "/" : path.startsWith(to));

  return (
    <div className="min-h-dvh lg:flex">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r bg-sidebar px-4 py-6 lg:flex">
        <div className="mb-8 flex items-center gap-2.5 px-2">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Leaf className="h-5 w-5" />
          </span>
          <span className="font-display text-xl font-semibold">Dziennik</span>
        </div>
        <nav className="flex flex-col gap-1" aria-label="Główna nawigacja">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className={cn(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                isActive(to)
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="h-5 w-5" /> {label === "Dodaj" ? "Dodaj posiłek" : label}
            </Link>
          ))}
          <Link
            to="/skanuj"
            className={cn(
              "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
              isActive("/skanuj")
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <ScanLine className="h-5 w-5" /> Skanuj etykietę
          </Link>
        </nav>
        <p className="mt-auto px-2 text-xs text-muted-foreground">Prywatny dziennik żywienia</p>
      </aside>

      <main className="pt-safe mx-auto w-full max-w-md px-4 pb-32 pt-5 sm:max-w-xl lg:max-w-4xl lg:px-10 lg:pb-12 lg:pt-10">
        {children}
      </main>

      {/* Mobile bottom nav */}
      <nav
        className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t bg-card/90 backdrop-blur-xl lg:hidden"
        aria-label="Główna nawigacja"
      >
        <ul className="mx-auto grid max-w-md grid-cols-5 items-end px-2 pt-1.5 pb-1.5">
          {NAV.map(({ to, label, icon: Icon, ...rest }) => {
            const active = isActive(to);
            if ("primary" in rest) {
              return (
                <li key={to} className="flex justify-center">
                  <Link
                    to={to}
                    aria-label="Dodaj posiłek"
                    className="-mt-6 grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-float transition-transform active:scale-95"
                  >
                    <Icon className="h-7 w-7" />
                  </Link>
                </li>
              );
            }
            return (
              <li key={to}>
                <Link
                  to={to}
                  className={cn(
                    "flex min-h-12 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors",
                    active ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  <Icon className={cn("h-[22px] w-[22px]", active && "stroke-[2.4]")} />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
