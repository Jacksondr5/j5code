import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { j5Sharing } from "./guestAccess";

const NOT_A_GUEST = Atom.make(false);
const NOTHING = {};
const VIEW_ONLY = { placeholder: "You can read this thread, but not send anything to it." };

/**
 * What a guest's composer says when their level on the thread is View: the placeholder is the
 * cue, since upstream has no disabled-input state of its own to say it. For everyone else, a
 * member without "Operate tasks" among them, it is nothing, and upstream's own text stands.
 */
export function useViewOnlyComposerProps(
  environmentId: EnvironmentId | null,
  canOperateThread: boolean,
): { readonly placeholder?: string } {
  const isGuest = useAtomValue(
    environmentId === null ? NOT_A_GUEST : j5Sharing.isGuest(environmentId),
  );
  return isGuest && !canOperateThread ? VIEW_ONLY : NOTHING;
}
