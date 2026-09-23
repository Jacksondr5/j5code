import { useEffect, useRef } from "react";
import { AppState } from "react-native";

/** Refresh on return to the thread; only an active run keeps a foreground timer. */
export function useActivePlaybookRefresh(input: {
  focused: boolean;
  connected: boolean;
  supported: boolean;
  activeRun: boolean;
  isPending: boolean;
  refresh: () => void;
}) {
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });
  useEffect(() => {
    if (!input.focused || !input.connected || !input.supported) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = () => {
      if (AppState.currentState === "active" && !latest.current.isPending) latest.current.refresh();
    };
    const sync = () => {
      clearInterval(timer);
      if (input.activeRun && AppState.currentState === "active")
        timer = setInterval(refresh, 7_500);
    };
    const onAppState = () => {
      sync();
      refresh();
    };
    sync();
    refresh();
    const subscription = AppState.addEventListener("change", onAppState);
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [input.focused, input.connected, input.supported, input.activeRun]);
}
