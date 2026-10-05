import {
  AgentPersonaId,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../mcp/OrchestratorMcpService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { prepareAgentPersonaLaunch } from "./agentPersonaLaunch.ts";
import { makeAgentPersonaLibrary } from "./agentPersonaLibrary.ts";
import { resolveAgentPersonaRuntime } from "./agentPersonaRuntime.ts";
import { translateAgentPersonaProviderPolicy } from "./agentPersonaProviderPolicy.ts";

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
  const threads = yield* ThreadManagementService;
  const service = yield* OrchestratorMcpService;
  const registry = yield* ProviderRegistry;
  const library = yield* makeAgentPersonaLibrary;
  const parent = yield* threads
    .getThreadProjection(scope.threadId)
    .pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({ code: "orchestration_error", message: String(error) }),
      ),
    );
  const assignment = yield* prepareAgentPersonaLaunch(
    { personaId: input.personaId },
    yield* registry.getProviders,
    library,
  ).pipe(
    Effect.mapError(
      (error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
    ),
  );
  const parentPolicy = yield* resolveAgentPersonaRuntime(parent.thread, library).pipe(
    Effect.mapError(
      (error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
    ),
  );
  const policy = translateAgentPersonaProviderPolicy(
    assignment.authorityPolicy,
    assignment.resolvedDriver,
  );
  if (
    parent.thread.agentPersonaAssignment !== undefined &&
    "sandboxPolicy" in parentPolicy &&
    parentPolicy.sandboxPolicy.type === "readOnly" &&
    policy.sandboxPolicy.type !== "readOnly"
  ) {
    return yield* new OrchestratorMcpFailure({
      code: "runtime_mode_escalation_denied",
      message: "A read-only agent cannot invoke an agent with write access.",
    });
  }
  const { personaId: _personaId, ...delegate } = input;
  return yield* service.delegateTask(scope, {
    ...delegate,
    title: input.title ?? assignment.displayName ?? input.personaId,
    mode: input.mode ?? "async",
    runtimeMode: policy.runtimeMode,
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
