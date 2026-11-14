import { Link } from "@tanstack/react-router";
import { InboxIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { inboxBellPresentation, mergeOpenInboxCounts } from "@t3tools/client-runtime/j5/inbox";

import { useSidebar } from "../../components/ui/sidebar";
import { cn } from "../../lib/utils";
import { inboxBellCount } from "@t3tools/client-runtime/j5/crew-inbox-requests";
import { useCrewRuntimeRequests } from "../crew/crewRuntimeRequestsClient";
import {
  crewRuntimeRequestSourcesAtom,
  inboxCountQueryAtom,
  inboxCountSourcesAtom,
  refreshJ5Sources,
} from "../state";
import { createVisibleRefreshHook } from "../useVisibleRefresh";

const useCountRefresh = createVisibleRefreshHook(() => {
  void refreshJ5Sources(inboxCountSourcesAtom, inboxCountQueryAtom);
});

export function HumanInboxBell({ onBackdrop }: { readonly onBackdrop: boolean }) {
  const { isMobile, setOpenMobile } = useSidebar();
  // Mounts the Crew request reads and refreshes them on focus; the count reads their sources.
  useCrewRuntimeRequests();
  const bell = inboxBellCount(
    mergeOpenInboxCounts(useAtomValue(inboxCountSourcesAtom)),
    useAtomValue(crewRuntimeRequestSourcesAtom),
  );
  useCountRefresh();

  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };

  const { badge, label } = inboxBellPresentation(bell);
  return (
    <Link
      aria-label={label}
      className={cn(
        "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-md outline-hidden transition-colors [-webkit-app-region:no-drag] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        onBackdrop
          ? "text-white/80 hover:bg-white/15 hover:text-white"
          : "text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground",
      )}
      onClick={closeMobileSidebar}
      title={label}
      to="/inbox"
    >
      <InboxIcon aria-hidden className="size-4" />
      {badge !== null ? (
        <span className="absolute -end-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-3xs font-semibold leading-none text-primary-foreground tabular-nums ring-2 ring-sidebar">
          {badge}
        </span>
      ) : null}
    </Link>
  );
}
