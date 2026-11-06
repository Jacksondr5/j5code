import {
  AgentPersonaId,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpInvocationContext, requireThreadScope } from "../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService, resolveRuntimeMode } from "../../mcp/OrchestratorMcpService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { AgentPersonaPickError, pickAgentPersona, turnPickSource } from "./agentPersonaPick.ts";

const {
  target: _target,
  runtimeMode: _runtimeMode,
  ...delegateFields
} = OrchestratorMcpDelegateTaskInput.fields;

/** A saved agent pins provider, model, reasoning, and runtime mode, so those fields are not accepted. */
export const InvokeAgentInput = Schema.Struct({
  personaId: AgentPersonaId,
  ...delegateFields,
});

/** Resolve a saved persona at the fork boundary; the upstream engine owns child lifecycle. */
export const invokeAgent = Effect.fn("j5.invokeAgent")(function* (
  input: typeof InvokeAgentInput.Type,
) {
  const scope = yield* McpInvocationContext;
  if (!scope.capabilities.has("orchestration")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This session cannot invoke agents.",
    });
  }
  const { thread } = yield* requireThreadScope(scope, "delegate_task");
  const threads = yield* ThreadManagementService;
  const service = yield* OrchestratorMcpService;
  const parent = yield* threads
    .getThreadRecords(thread.threadId, [])
    .pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({ code: "orchestration_error", message: String(error) }),
      ),
    );
  const refused = (error: AgentPersonaPickError) =>
    new OrchestratorMcpFailure({
      code:
        error.constraint === "access-above-caller"
          ? "runtime_mode_escalation_denied"
          : "invalid_request",
      message: error.message,
    });
  const { assignment, runtimeMode: childMode } = yield* pickAgentPersona({
    personaId: input.personaId,
    source: yield* turnPickSource(thread.threadId, input.personaId).pipe(Effect.mapError(refused)),
    caller: { thread: parent.thread },
    projectId: parent.thread.projectId,
  }).pipe(Effect.mapError(refused));
  // delegateTask holds a child to the parent's stored mode. The pick has already judged access,
  // and the child's real permissions come from its persona snapshot, so a broader child inherits.
  const runtimeMode = (yield* resolveRuntimeMode(parent.thread.runtimeMode, childMode).pipe(
    Effect.match({ onFailure: () => true, onSuccess: () => false }),
  ))
    ? "inherit"
    : childMode;
  const { personaId: _personaId, ...delegate } = input;
  return yield* service.delegateTask(scope, {
    ...delegate,
    title: input.title ?? assignment.displayName ?? input.personaId,
    mode: input.mode ?? "async",
    runtimeMode,
    target: {
      providerInstanceId: assignment.resolvedModelSelection.instanceId,
      model: assignment.resolvedModelSelection.model,
      ...(assignment.resolvedModelSelection.options === undefined
        ? {}
        : { options: assignment.resolvedModelSelection.options }),
    },
    agentPersonaAssignment: assignment,
  });
});
