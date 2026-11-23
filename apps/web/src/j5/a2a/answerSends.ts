import { useState } from "react";

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Each ask's send, by its item key: one ask delivering locks only itself, and an error stays with
 * the ask it belongs to, so sends on two asks never unlock or overwrite each other.
 */
export function useAnswerSends() {
  const [pending, setPending] = useState(NO_KEYS);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  return {
    isPending: (key: string) => pending.has(key),
    errorOf: (key: string): string | null => errors[key] ?? null,
    setPending: (key: string, sending: boolean) =>
      setPending((current) => {
        if (current.has(key) === sending) return current;
        const next = new Set(current);
        if (sending) next.add(key);
        else next.delete(key);
        return next;
      }),
    setError: (key: string, error: string | null) =>
      setErrors((current) => {
        if (error !== null) return { ...current, [key]: error };
        if (!(key in current)) return current;
        const rest = { ...current };
        delete rest[key];
        return rest;
      }),
  };
}

export type AnswerSends = ReturnType<typeof useAnswerSends>;

/**
 * What an answer delivers: exactly what was typed, edge spaces and newlines included (Inbox AC8),
 * or `null` when it is only whitespace and so has no words to send.
 */
export const answerToDeliver = (typed: string): string | null =>
  typed.trim() === "" ? null : typed;

/** The callbacks `submitHumanInboxAnswer` reports one send of the ask `key` through. */
export function answerSendCallbacks(sends: AnswerSends, key: string, onAccepted: () => void) {
  return {
    onAccepted,
    setPendingExchangeId: (pendingKey: string | null) => sends.setPending(key, pendingKey !== null),
    setError: (message: string | null) => sends.setError(key, message),
  };
}
