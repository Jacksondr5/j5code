import { useEffect } from "react";

/** A feature's consumers share one foreground timer, so another picker costs no extra poll. */
export function createVisibleRefreshHook(refresh: () => void, intervalMs: number) {
  let consumers = 0;
  let stop: (() => void) | undefined;
  return function useVisibleRefresh() {
    useEffect(() => {
      consumers += 1;
      if (consumers === 1) {
        let timer: ReturnType<typeof setInterval> | undefined;
        let lastRefresh = Date.now();
        const refreshVisible = () => {
          if (document.visibilityState !== "visible" || Date.now() - lastRefresh < 1_000) return;
          lastRefresh = Date.now();
          refresh();
        };
        const syncTimer = () => {
          clearInterval(timer);
          timer =
            document.visibilityState === "visible"
              ? setInterval(refreshVisible, intervalMs)
              : undefined;
        };
        const onVisibility = () => {
          refreshVisible();
          syncTimer();
        };
        syncTimer();
        window.addEventListener("focus", refreshVisible);
        document.addEventListener("visibilitychange", onVisibility);
        stop = () => {
          clearInterval(timer);
          window.removeEventListener("focus", refreshVisible);
          document.removeEventListener("visibilitychange", onVisibility);
        };
      }
      return () => {
        consumers -= 1;
        if (consumers === 0) {
          stop?.();
          stop = undefined;
        }
      };
    }, []);
  };
}
