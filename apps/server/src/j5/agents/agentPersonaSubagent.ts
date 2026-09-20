import type { ModelSelection, OrchestrationV2AgentPersonaAssignment } from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import { validateAgentPersonaAssignment } from "./agentPersonaAssignment.ts";
import { AgentPersonaLibraryError, type createAgentPersonaLibrary } from "./agentPersonaLibrary.ts";

/** Explicit imported children carry their own snapshot; native children still inherit no persona. */
export const validateAgentPersonaSubagent = Effect.fn("j5.validateAgentPersonaSubagent")(function* (
  command: {
    readonly agentPersonaAssignment?: OrchestrationV2AgentPersonaAssignment | undefined;
    readonly modelSelection: ModelSelection;
  },
  library: ReturnType<typeof createAgentPersonaLibrary>,
  driver: string,
) {
  const assignment = command.agentPersonaAssignment;
  if (assignment === undefined) return;
  const definition = yield* library.readSnapshot(assignment);
  const error = validateAgentPersonaAssignment(assignment, definition);
  if (error !== undefined) return yield* new AgentPersonaLibraryError({ message: error });
  if (
    driver !== assignment.resolvedDriver ||
    !modelSelectionsEqual(command.modelSelection, assignment.resolvedModelSelection)
  ) {
    return yield* new AgentPersonaLibraryError({
      message: "Agent assignment must match the child provider and model route.",
    });
  }
});
