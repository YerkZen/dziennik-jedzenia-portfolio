import { useEffect, useRef, useState } from "react";
import { hasPrivateDrafts } from "@/lib/auth/private-drafts";
import { privateObjectUrlCount } from "@/lib/auth/private-object-urls";
import { Btn } from "./ui";

function hasOpenWork(): boolean {
  return (
    hasPrivateDrafts() ||
    privateObjectUrlCount() > 0 ||
    !!document.querySelector("form, [role='dialog']")
  );
}
export function PwaUpdate() {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [available, setAvailable] = useState(false);
  const [message, setMessage] = useState("");
  const reloading = useRef(false);
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    let closed = false;
    let registered: ServiceWorkerRegistration | undefined;
    const check = () => {
      if (!closed) setAvailable(!!registered?.waiting);
    };
    const found = () => {
      const installing = registered?.installing;
      installing?.addEventListener("statechange", check);
    };
    const changed = () => {
      if (reloading.current && !hasOpenWork()) window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", changed);
    const register = () => {
      if (closed) return;
      void navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then((value) => {
          registered = value;
          if (closed) return;
          setRegistration(value);
          check();
          value.addEventListener("updatefound", found);
        })
        .catch(() => {
          /* The online app remains usable without installation. */
        });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
    return () => {
      closed = true;
      window.removeEventListener("load", register);
      registered?.removeEventListener("updatefound", found);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
    };
  }, []);
  async function update() {
    if (hasOpenWork()) {
      setMessage("Zapisz lub odrzuć szkice i zamknij formularze przed aktualizacją.");
      return;
    }
    const waiting = registration?.waiting;
    if (!waiting) return;
    const channel = new MessageChannel();
    reloading.current = true;
    const timeout = window.setTimeout(() => {
      reloading.current = false;
      channel.port1.close();
      setMessage("Nie udało się wczytać aktualizacji. Spróbuj ponownie.");
    }, 5000);
    channel.port1.onmessage = (event: MessageEvent<{ accepted?: boolean }>) => {
      window.clearTimeout(timeout);
      channel.port1.close();
      if (event.data.accepted !== true) {
        reloading.current = false;
        setMessage("Zamknij pozostałe karty dziennika, aby wczytać aktualizację.");
      }
    };
    waiting.postMessage({ type: "ACTIVATE_WHEN_ALONE" }, [channel.port2]);
  }
  if (!available) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-3 top-3 z-[60] mx-auto max-w-lg rounded-2xl border bg-card p-4 shadow-lg"
    >
      <p className="mb-2 text-sm">Nowa wersja dziennika jest gotowa.</p>
      {message && <p className="mb-2 text-sm">{message}</p>}
      <Btn variant="outline" onClick={() => void update()}>
        Wczytaj aktualizację
      </Btn>
    </div>
  );
}
