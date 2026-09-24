import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedSquadronRef } from "@t3tools/contracts/j5";

import type { SquadronDraftState } from "./SquadronScope.logic";

export type SquadronActionsState =
  | { readonly kind: "hidden" }
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "ready" };

/**
 * Rename and delete act on the ambient scope's Squadron only. "All Squadrons" names nothing, so
 * the actions are absent; a Squadron on an offline or read-only environment shows them disabled.
 */
export const resolveSquadronActionsState = (
  target: { readonly available: boolean } | null,
): SquadronActionsState => {
  if (target === null) return { kind: "hidden" };
  if (!target.available) {
    return {
      kind: "disabled",
      reason: "This connection cannot change Squadrons right now.",
    };
  }
  return { kind: "ready" };
};

export type SquadronRenameState =
  | { readonly kind: "missing-name"; readonly message: string }
  | { readonly kind: "unchanged" }
  | { readonly kind: "ready"; readonly name: string };

/** The server trims and rejects empty names too; the dialog mirrors that before it submits. */
export const resolveSquadronRenameState = (input: {
  readonly draftName: string;
  readonly currentName: string;
}): SquadronRenameState => {
  const name = input.draftName.trim();
  if (name.length === 0) {
    return { kind: "missing-name", message: "A Squadron needs a name." };
  }
  if (name === input.currentName) return { kind: "unchanged" };
  return { kind: "ready", name };
};

const sameSquadron = (left: ScopedSquadronRef, right: ScopedSquadronRef) =>
  left.environmentId === right.environmentId && left.squadronId === right.squadronId;

/** A deleted Squadron cannot stay the ambient scope; the sidebar falls back to All Squadrons. */
export const resolveScopeAfterSquadronDelete = (
  ambient: ScopedSquadronRef | null,
  deleted: ScopedSquadronRef,
): ScopedSquadronRef | null =>
  ambient !== null && sameSquadron(ambient, deleted) ? null : ambient;

/**
 * Draft carriers are keyed by scoped thread ref and hold a bare Squadron id, so only carriers on
 * the deleted Squadron's own environment are dropped. Returns the same record when nothing
 * pointed at it, so subscribers are not notified for nothing.
 */
export const dropDraftStatesForDeletedSquadron = <TContent>(
  draftStates: Readonly<Record<string, SquadronDraftState<TContent>>>,
  deleted: ScopedSquadronRef,
): Readonly<Record<string, SquadronDraftState<TContent>>> => {
  const remaining = Object.entries(draftStates).filter(
    ([key, state]) =>
      !(
        state.squadronId === deleted.squadronId &&
        parseScopedThreadKey(key)?.environmentId === deleted.environmentId
      ),
  );
  return remaining.length === Object.keys(draftStates).length
    ? draftStates
    : Object.fromEntries(remaining);
};

export type SquadronDeleteFailure =
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

/**
 * The server refuses with 409 when live members, Crews, or other rows still depend on the
 * Squadron; its message names what blocks the deletion and is shown verbatim.
 */
export const describeSquadronDeleteFailure = (error: unknown): SquadronDeleteFailure => {
  if (error instanceof Error) {
    if ("status" in error && error.status === 409) {
      return { kind: "refused", message: error.message };
    }
    if (error.message.length > 0) return { kind: "failed", message: error.message };
  }
  return { kind: "failed", message: "Could not delete the Squadron." };
};
