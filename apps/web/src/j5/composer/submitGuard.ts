import type { SteerState } from "@t3tools/client-runtime/j5/steer-state";
import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";

/** Question answers and queued edits do not try to steer the active provider turn. */
export function shouldRefuseComposerSteer(input: {
  readonly dispatchMode: ComposerDispatchMode;
  readonly steerState: SteerState;
  readonly isEditingQueuedMessage: boolean;
  readonly isAnsweringQuestion: boolean;
}): boolean {
  return (
    input.dispatchMode === "steer" &&
    input.steerState.kind === "not-steerable" &&
    !input.isEditingQueuedMessage &&
    !input.isAnsweringQuestion
  );
}
