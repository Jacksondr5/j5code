import { useState } from "react";

/** Why an ask's last send failed; `delivered` when the server took it and only the re-read failed. */
export interface AnswerSendError {
  readonly message: string;
  readonly delivered: boolean;
}

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Each ask's send, by its item key: one ask delivering locks only itself, and an error stays with
 * the ask it belongs to, so sends on two asks never unlock or overwrite each other.
 */
export function useAnswerSends() {
  const [pending, setPending] = useState(NO_KEYS);
  const [errors, setErrors] = useState<Readonly<Record<string, AnswerSendError>>>({});
  return {
    isPending: (key: string) => pending.has(key),
    errorOf: (key: string): AnswerSendError | null => errors[key] ?? null,
    setPending: (key: string, sending: boolean) =>
      setPending((current) => {
        if (current.has(key) === sending) return current;
        const next = new Set(current);
        if (sending) next.add(key);
        else next.delete(key);
        return next;
      }),
    setError: (key: string, error: AnswerSendError | null) =>
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
