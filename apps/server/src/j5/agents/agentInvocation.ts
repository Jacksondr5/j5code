import {
  AgentPersonaId,
  OrchestratorMcpDelegateTaskInput,
  ThreadId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpInvocationContext, requireThreadScope } from "../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService, resolveRuntimeMode } from "../../mcp/OrchestratorMcpService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { participantIdForThread } from "../a2a/HomeRegistrar.ts";
import { AgentPersonaEscalations } from "./agentPersonaEscalation.ts";
import { AgentPersonaPickError, pickAgentPersona, turnPickSource } from "./agentPersonaPick.ts";
import { withReviewIndependenceNote } from "./agentPersonaReviewIndependence.ts";

const {
  target: _target,
  runtimeMode: _runtimeMode,
  ...delegateFields
} = OrchestratorMcpDelegateTaskInput.fields;

/** A saved agent pins provider, model, reasoning, and runtime mode, so those fields are not accepted. */
export const InvokeAgentInput = Schema.Struct({
  personaId: AgentPersonaId,
  ...delegateFields,
  authorThreads: Schema.optional(Schema.Array(ThreadId)),
  allowOnce: Schema.optional(Schema.String),
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
  // Upstream's failure codes are fixed, so a persona's block code rides in the message text.
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
    reviewAuthors: {
      threads:
        input.authorThreads === undefined
          ? [{ threadId: thread.threadId }]
          : input.authorThreads.map((threadId) => ({ threadId, named: true })),
    },
    escalateFor: participantIdForThread(thread.threadId),
    allowOnce: input.allowOnce,
  }).pipe(Effect.mapError(refused));
  if (assignment.pickSource?.kind === "allow-once")
    yield* (yield* AgentPersonaEscalations)
      .use(input.allowOnce!)
      .pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
        ),
      );
  // delegateTask holds a child to the parent's stored mode. The pick has already judged access,
  // and the child's real permissions come from its persona snapshot, so a broader child inherits.
  const runtimeMode = (yield* resolveRuntimeMode(parent.thread.runtimeMode, childMode).pipe(
    Effect.match({ onFailure: () => true, onSuccess: () => false }),
  ))
    ? "inherit"
    : childMode;
  const {
    personaId: _personaId,
    authorThreads: _authorThreads,
    allowOnce: _allowOnce,
    ...delegate
  } = input;
  return yield* service.delegateTask(scope, {
    ...delegate,
    task: withReviewIndependenceNote(input.task, assignment),
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
