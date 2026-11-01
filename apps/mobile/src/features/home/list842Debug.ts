// DEBUG ONLY (#842): variant switch and row logging for the Chats list. Do not merge.
import { useSyncExternalStore } from "react";
import { DevSettings } from "react-native";

export type List842Variant = "base" | "norecycle" | "bump";
let variant: List842Variant = "base";
const listeners = new Set<() => void>();
const setVariant = (next: List842Variant) => {
  variant = next;
  console.log("LIST842 variant", next);
  listeners.forEach((listener) => listener());
};
for (const next of ["base", "norecycle", "bump"] as const) {
  DevSettings.addMenuItem(`LIST842: ${next}`, () => setVariant(next));
}

export function useList842Variant(): List842Variant {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => variant,
  );
}

const rendered = new Set<string>();
export function logList842Render(key: string) {
  if (rendered.has(key)) return;
  rendered.add(key);
  console.log("LIST842 first-render", variant, key);
}

let lastData = "";
export function logList842Data(keys: ReadonlyArray<string>) {
  const signature = keys.join(",");
  if (signature === lastData) return;
  const previous = new Set(lastData === "" ? [] : lastData.split(","));
  lastData = signature;
  const added = keys.filter((key) => !previous.has(key));
  console.log("LIST842 data", variant, "n=", keys.length, "added=", JSON.stringify(added));
}
