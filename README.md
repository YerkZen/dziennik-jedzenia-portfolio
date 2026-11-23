# Dziennik Jedzenia

Prywatny dziennik posiłków i masy ciała. Pozwala zapisywać produkty i zestawy składników, obliczać dzienne spożycie kalorii i makroskładników oraz porównywać wyniki z celami. Zapisany posiłek zachowuje wartości odżywcze z chwili zapisu, dzięki czemu późniejsza edycja produktu nie zmienia historii.

Aplikacja udostępnia statystyki spożycia i masy ciała oraz pozwala użyć zdjęcia etykiety do wstępnego uzupełnienia wartości odżywczych. Propozycję z etykiety użytkownik sprawdza i zatwierdza przed zapisem.

## Architektura

- **Frontend** — React, TypeScript, Vite, TanStack Router i Query, Tailwind CSS. Interfejs jest dostępny jako PWA.
- **API** — Cloudflare Worker z Hono. Frontend i API współdzielą origin. Worker obsługuje sesje w ciasteczkach, walidację żądań i limity ruchu.
- **Dane** — PostgreSQL w Supabase. Supabase Auth obsługuje logowanie, a API korzysta z PostgREST i funkcji SQL. Migracje definiują model, uprawnienia i zasady Row-Level Security.
- **Odczyt etykiet** — adapter Workers AI w Workerze. Zapis produktu pozostaje osobną operacją.

Kod interfejsu jest w `src/`, kod API w `worker/`, a schemat bazy i funkcje w `supabase/migrations/`. Przykłady żądań i odpowiedzi opisuje [kontrakt API](docs/openapi.yaml).

## Jak pracowałem z Codexem

Określałem problem, priorytety i kryteria akceptacji. Podejmowałem decyzje produktowe, rozstrzygałem kompromisy techniczne i zatwierdzałem zmiany oraz wdrożenia. Codex pomagał doprecyzować wymagania i proponował rozwiązania. Generował znaczną część kodu, testów i dokumentacji. Scenariusze akceptacji i wyniki testów służyły do przeglądu kolejnych iteracji.

## Przegląd i kompilacja

Użyj wersji Node.js z `.nvmrc` oraz npm 11.

```sh
npm ci
npm run typecheck
npm run build
```

Build tworzy frontend w `dist/` oraz pakiet Workera w `dist-worker/`. Wrangler uruchamia się w trybie `--dry-run`. Te polecenia nie wymagają dostępu do bazy ani konta Cloudflare.

Pełne uruchomienie wymaga własnej instancji Supabase, zastosowania migracji, skonfigurowania konta właściciela i ustawienia zmiennych Workera `APP_ORIGIN`, `SUPABASE_URL` oraz `SUPABASE_PUBLISHABLE_KEY`. Odczyt zdjęć dodatkowo wymaga bindingu `AI`. Eksport służy do przeglądu kodu i kompilacji. Obejmuje testy jednostkowe i testy Workera (`npm test`), a pomija prywatne testy procesu oraz zestawy wymagające pełnego środowiska z bazą i przeglądarką.
