import { useRef, useState } from "react";
import { useAuth } from "@/lib/auth/context";
import { discardPrivateDraft, readPrivateDraft, savePrivateDraft } from "@/lib/auth/private-drafts";
import { ApiRequestError } from "./client";
import type { MutationAck } from "./products";

interface Command<T> {
  input: T;
  key: string;
}
/** Private RAM only. The original command survives closing a form until it is settled or logout. */
export function useFrozenMutation<T>(draftKey: string) {
  const { snapshot } = useAuth();
  const owner = snapshot.session?.owner_id;
  const key = `command:${draftKey}`;
  const [, refresh] = useState(0);
  const active = useRef(new Set<string>());
  const read = () => (owner ? (readPrivateDraft<Command<T>>(key, owner) ?? null) : null);
  function remember(value: Command<T> | null) {
    if (value && owner) savePrivateDraft(key, owner, value);
    else discardPrivateDraft(key);
    refresh((n) => n + 1);
  }
  async function run(input: T, send: (input: T, key: string) => Promise<MutationAck>) {
    if (active.current.has(key)) throw new ApiRequestError("Trwa zapisywanie.", 0, "IN_PROGRESS");
    if (!owner)
      throw new ApiRequestError(
        "Zaloguj się ponownie, aby potwierdzić zapis.",
        401,
        "SESSION_REQUIRED",
      );
    const prior = read();
    if (typeof navigator !== "undefined" && !navigator.onLine)
      throw new ApiRequestError(
        prior
          ? "Brak połączenia. Wcześniejszy zapis pozostaje niepotwierdzony. Ponów po odzyskaniu połączenia."
          : "Brak połączenia. Formularz nie został wysłany.",
        0,
        "OFFLINE",
      );
    const command = prior ?? { input: structuredClone(input), key: crypto.randomUUID() };
    remember(command);
    active.current.add(key);
    try {
      const ack = await send(command.input, command.key);
      if (!ack || typeof ack.resource_id !== "string" || !Number.isInteger(ack.current_revision))
        throw new ApiRequestError("Nie udało się potwierdzić zapisu. Ponów.", 0, "INVALID_ACK");
      remember(null);
      return { ack, input: command.input };
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      )
        remember(null);
      throw error;
    } finally {
      active.current.delete(key);
    }
  }
  return { run, frozen: read() !== null, command: read()?.input, reset: () => remember(null) };
}
