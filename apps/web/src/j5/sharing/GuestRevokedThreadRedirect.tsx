import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { useEnvironmentThreadRefs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { useIsGuest } from "./guestAccess";
import { guestIsLeftOnNothing } from "./joinPage.logic";

/**
 * Takes a guest off a thread's address when the last thing shared with them is taken away while
 * they have it open. Upstream leaves a missing thread's address only when the server has another
 * thread to show, so a guest was left on an empty page; their first screen says nothing is shared.
 */
export function GuestRevokedThreadRedirect() {
  const params = useParams({ strict: false }) as {
    readonly environmentId?: string;
    readonly threadId?: string;
  };
  const environmentId =
    params.threadId === undefined ? null : ((params.environmentId ?? null) as EnvironmentId | null);
  const isGuest = useIsGuest(environmentId);
  const shell = useEnvironmentQuery(
    environmentId === null ? null : environmentShell.stateAtom(environmentId),
  );
  const threadCount = useEnvironmentThreadRefs(environmentId).length;
  const navigate = useNavigate();
  const leftOnNothing = guestIsLeftOnNothing({
    isGuest,
    onThreadAddress: environmentId !== null,
    listed: shell.data?.snapshot._tag === "Some",
    threadCount,
  });
  useEffect(() => {
    if (leftOnNothing) void navigate({ to: "/", replace: true });
  }, [leftOnNothing, navigate]);
  return null;
}
