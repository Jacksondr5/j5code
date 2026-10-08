import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import type { ScopedSquadronRef } from "@t3tools/contracts/j5";

import { isSidebarMember } from "../threads/sidebarMembership";

export interface SquadronChoice {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly name: string;
}

/** The sidebar can set ambient context, but it must never manufacture a choice. */
export const resolveSquadronScope = <T extends SquadronChoice>(
  choices: ReadonlyArray<T>,
  selected: ScopedSquadronRef | null,
): T | null =>
  choices.find(
    (choice) =>
      choice.id === selected?.squadronId && choice.environmentId === selected.environmentId,
  ) ?? null;

export type SidebarThreadHome =
  | {
      readonly kind: "known";
      readonly squadron: { readonly id: string };
      readonly origin?: "human" | "agent" | undefined;
    }
  | { readonly kind: "unknown" };

/**
 * SB5 membership first, then the selected scope, which admits only that Squadron's immutable,
 * known Registrar homes. Homes are keyed by scoped thread ref, so the same thread id in two
 * environments never shares a home.
 */
export const filterThreadsForSquadronScope = <
  T extends {
    readonly id: string;
    readonly environmentId: EnvironmentId;
    readonly pinnedAt?: string | null | undefined;
  },
>(
  threads: ReadonlyArray<T>,
  scope: SquadronChoice | null,
  homesByThreadId: ReadonlyMap<string, SidebarThreadHome>,
) => {
  const homeOf = (thread: T) =>
    homesByThreadId.get(
      scopedThreadKey(scopeThreadRef(thread.environmentId, ThreadId.make(thread.id))),
    );
  const members = threads.filter((thread) => isSidebarMember(thread, homeOf(thread)));
  if (scope === null) return members;
  return members.filter((thread) => {
    const home = homeOf(thread);
    return (
      thread.environmentId === scope.environmentId &&
      home?.kind === "known" &&
      home.squadron.id === scope.id
    );
  });
};
