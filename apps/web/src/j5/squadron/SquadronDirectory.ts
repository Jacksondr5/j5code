import { useAtomValue } from "@effect/atom-react";
import { mergeSquadronSources } from "@t3tools/client-runtime/j5/squadrons";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { refreshJ5Sources, squadronQueryAtom, squadronSourcesAtom } from "../state";
import { createVisibleRefreshHook } from "../useVisibleRefresh";

export type {
  SquadronDirectoryState,
  ScopedManagedSquadron,
} from "@t3tools/client-runtime/j5/squadrons";
export { mergeSquadronSources } from "@t3tools/client-runtime/j5/squadrons";

const directoryAtom = Atom.make((get) => mergeSquadronSources(get(squadronSourcesAtom)));

export const refreshSquadronDirectory = (
  options: { readonly environmentId?: EnvironmentId; readonly force?: boolean } = {},
) => refreshJ5Sources(squadronSourcesAtom, squadronQueryAtom, options);

const useDirectoryRefresh = createVisibleRefreshHook(() => {
  void refreshSquadronDirectory();
}, 30_000);

/** One registry-backed read per environment is shared by the gate and every scope control. */
export function useSquadronDirectory() {
  const state = useAtomValue(directoryAtom);
  useDirectoryRefresh();
  return { ...state, refresh: refreshSquadronDirectory };
}
