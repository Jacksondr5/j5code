import { Link } from "@tanstack/react-router";
import { BellIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useSidebar } from "../../components/ui/sidebar";
import { cn } from "../../lib/utils";
import { readOpenInboxCount } from "./humanInboxCountClient";
import { HUMAN_INBOX_REFRESH_EVENT } from "./humanInboxRefresh";

export const COUNT_POLL_INTERVAL_MS = 7_500;

export const shouldShowOpenInboxCount = (count: number | null) => count !== null && count > 0;

export function HumanInboxBell({ onBackdrop }: { readonly onBackdrop: boolean }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let refreshQueued = false;
    let interval: number | undefined;
    const refresh = () => {
      if (!active) return;
      if (inFlight) {
        refreshQueued = true;
        return;
      }
      inFlight = true;
      void readOpenInboxCount()
        .then((response) => {
          if (active) setCount(response.count);
        })
        .catch(() => {
          if (active) setCount(null);
        })
        .finally(() => {
          inFlight = false;
          if (active && refreshQueued) {
            refreshQueued = false;
            refresh();
          }
        });
    };
    const syncInterval = () => {
      window.clearInterval(interval);
      interval =
        document.visibilityState === "visible"
          ? window.setInterval(refresh, COUNT_POLL_INTERVAL_MS)
          : undefined;
    };
    const refreshVisibleWindow = () => {
      if (document.visibilityState === "visible") refresh();
      syncInterval();
    };
    refresh();
    syncInterval();
    window.addEventListener("focus", refreshVisibleWindow);
    window.addEventListener(HUMAN_INBOX_REFRESH_EVENT, refresh);
    document.addEventListener("visibilitychange", refreshVisibleWindow);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshVisibleWindow);
      window.removeEventListener(HUMAN_INBOX_REFRESH_EVENT, refresh);
      document.removeEventListener("visibilitychange", refreshVisibleWindow);
    };
  }, []);

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const label = count === null ? "Open inbox" : `Open inbox, ${count} open`;
  return (
    <Link
      aria-label={label}
      className={cn(
        "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-md outline-hidden transition-colors [-webkit-app-region:no-drag] focus-visible:ring-2 focus-visible:ring-ring",
        onBackdrop
          ? "text-white/80 hover:bg-white/15 hover:text-white"
          : "text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground",
      )}
      onClick={closeMobileSidebar}
      title={label}
      to="/inbox"
    >
      <BellIcon aria-hidden className="size-4" />
      {shouldShowOpenInboxCount(count) ? (
        <span className="absolute -end-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.625rem] font-semibold leading-none text-primary-foreground tabular-nums ring-2 ring-sidebar">
          {count}
        </span>
      ) : null}
    </Link>
  );
}
