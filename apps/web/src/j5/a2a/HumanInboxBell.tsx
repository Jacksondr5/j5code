import { BellIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { readOpenInboxCount } from "./humanInboxCountClient";

const COUNT_POLL_INTERVAL_MS = 30_000;

export function HumanInboxBell({ onBackdrop }: { readonly onBackdrop: boolean }) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void readOpenInboxCount()
        .then((response) => {
          if (active) setCount(response.count);
        })
        .catch(() => {
          if (active) setCount(null);
        });
    };
    refresh();
    const interval = window.setInterval(refresh, COUNT_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

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
      title={label}
      to="/inbox"
    >
      <BellIcon aria-hidden className="size-4" />
      {count === null ? null : (
        <span className="absolute -end-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.625rem] font-semibold leading-none text-primary-foreground tabular-nums ring-2 ring-sidebar">
          {count}
        </span>
      )}
    </Link>
  );
}
