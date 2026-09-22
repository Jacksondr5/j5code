import { useEffect } from "react";

/** A slow read finishes before another poll; hidden or unavailable environments stay quiet. */
export function usePlaybookRunsRefresh(refresh: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lastRefresh = 0;
    const read = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastRefresh < 1_000) return;
      lastRefresh = Date.now();
      refresh();
    };
    const sync = () => {
      clearInterval(timer);
      if (document.visibilityState === "visible") timer = setInterval(read, 2_500);
    };
    const onVisible = () => {
      sync();
      read();
    };
    sync();
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, enabled]);
}
