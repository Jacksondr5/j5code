import { useAtomValue } from "@effect/atom-react";
import { createSharingEnvironmentAtoms } from "@t3tools/client-runtime/j5/sharing";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentScope } from "../../state/session";

export const j5Sharing = createSharingEnvironmentAtoms(connectionAtomRuntime);

const NOTHING_WITHHELD = Atom.make(true);

/**
 * Whether this connection may write to a thread: upstream's server-wide "Operate tasks"
 * permission, and for a guest's connection also a Collaborate level on that thread. The chat
 * view calls this where it read the permission alone, so a guest with View gets what upstream
 * already shows a connection that lacks it. For a member's connection it is upstream's answer.
 */
export function useCanOperateThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): boolean {
  const permitted = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const shared = useAtomValue(
    environmentId === null ? NOTHING_WITHHELD : j5Sharing.threadOperable(environmentId, threadId),
  );
  return permitted && shared;
}
