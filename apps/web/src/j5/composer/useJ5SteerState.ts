import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveSteerState, type SteerState } from "@t3tools/client-runtime/j5/steer-state";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useThreadProjection } from "../../state/entities";

const IDLE: SteerState = { kind: "idle" };

/** Live steer state for the composer's thread; idle for drafts without a thread. */
export function useJ5SteerState(
  environmentId: EnvironmentId | undefined,
  threadId: ThreadId | null | undefined,
): SteerState {
  const projection = useThreadProjection(
    environmentId === undefined || threadId === null || threadId === undefined
      ? null
      : scopeThreadRef(environmentId, threadId),
  )?.projection;
  return useMemo(() => (projection ? deriveSteerState(projection) : IDLE), [projection]);
}
