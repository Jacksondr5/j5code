import {
  AgentPersonaId,
  type EnvironmentId,
  ThreadId,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, Tool } from "effect/ai";

import { hiddenFromOutsideClients, McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../mcp/OrchestratorMcpService.ts";
import { UnreachableCalls } from "../a2a/line/UnreachableCallsService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { requireThreadScope } from "../../mcp/McpInvocationContext.ts";
import * as PeerForwarding from "../../peer/PeerForwarding.ts";
import { PeerRegistryService } from "../a2a/PeerRegistryService.ts";
import { invokeAgent } from "./agentInvocation.ts";
import { resolveCallerAccess, turnPickSource } from "./agentPersonaPick.ts";
import { resolveReviewAuthors } from "./agentPersonaReviewIndependence.ts";
import {
  AgentPersonaEscalations,
  AllowOnceInput,
  BLOCKED_PERSONA_TOOL_TEXT,
} from "./agentPersonaEscalation.ts";
import { CrewMemberModels } from "./crewMemberModels.ts";

export const AuthorThreads = Schema.Array(ThreadId)
  .check(Schema.isMinLength(1), Schema.isMaxLength(32))
  .annotate({
    description:
      "Only with a persona that j5_list_personas marks independent_reviewer: the threads whose work it reviews. Omit when that is your own work and your delegate_task subagents'. The server prefers a model none of them ran on.",
  });

/**
 * Upstream's delegate_task input plus an optional persona. With `persona`, the server applies
 * the saved definition's instructions, model route, reasoning, and runtime policy; without it,
 * this is upstream's plain child delegation.
 */
export const J5DelegateTaskInput = Schema.Struct({
  ...OrchestratorMcpDelegateTaskInput.fields,
  persona: Schema.optional(
    AgentPersonaId.annotate({
      description:
        "Persona ID to run the child as, taken from an @persona:ID mention or the Settings → Agent Setup library. The server applies its instructions, model route, reasoning, and runtime policy. Omit target and runtimeMode when passing persona, except target.environmentId to run it on a peered J5 machine.",
    }),
  ),
  authorThreads: Schema.optional(AuthorThreads),
  allow_once: Schema.optional(AllowOnceInput),
});
export type J5DelegateTaskInput = typeof J5DelegateTaskInput.Type;

/**
 * Written for J5 rather than prefixed onto upstream's text: upstream's description tells the model to
 * use this tool for any subagent request, which contradicts the orchestration instructions that keep
 * ordinary subagent work provider-native. Here the persona use leads and the plain child is the
 * fallback.
 */
export const J5_DELEGATE_TASK_DESCRIPTION =
  "Create a subagent, the first of the two ways to get help (the second is a Crew member): start one child agent with only `task`. No parent history. Pass persona=ID when the user writes @persona:ID or asks for a persona by name, or when a persona from j5_list_personas fits the work: the server pins that persona's instructions, provider, model, reasoning, and runtime policy, so omit target and runtimeMode. To run the persona on a peered J5 machine, pass only target.environmentId. A persona the user named with @persona:ID in the message that started this turn runs as saved; one you pick yourself uses only its models the project's Models for custom members checks, and is refused if it needs more access than you run with. " +
  BLOCKED_PERSONA_TOOL_TEXT +
  " For a persona j5_list_personas marks independent_reviewer, the server prefers a model that didn't write the work: yours and your delegate_task children's unless authorThreads names other threads. Give the persona a self-contained task, and if that call fails, report the error instead of substituting a plain child. Without persona, this is a plain J5-tracked child for cross-provider work, for same-provider work the native subagent tool cannot run, or for work the user wants tracked as a J5 task; for an ordinary subagent request, use your provider's native subagent mechanism instead. Without persona the child's model and reasoning level, inherited ones included, must be ones the project's Models for custom members lists allow; a refusal lists the eligible ones to retry with in `target`. Separate checkout or PR per child: `isolation:'worktree'`. Keep `taskId` for `task_status` and `task_cancel`. No secrets in `task`.";

/** J5's delegate_task: the upstream tool with the persona extension, registered in place of it. */
export const J5DelegateTaskTool = Tool.make("delegate_task", {
  description: J5_DELEGATE_TASK_DESCRIPTION,
  parameters: J5DelegateTaskInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext,
    OrchestratorMcpService,
    ThreadManagementService,
    ProviderRegistry.ProviderRegistry,
    // A plain child's model and reasoning level are held to the project's lists for custom members.
    CrewMemberModels,
    // A refused persona is recorded as an escalation, and a granted one is spent.
    AgentPersonaEscalations,
    // A persona goes only to a machine this one is peered with.
    PeerRegistryService,
  ],
})
  .annotate(Tool.Title, "Delegate a child task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true)
  // As upstream's delegate_task, which this replaces: a child needs a calling thread to report to.
  .annotate(McpSchema.EnabledWhen, hiddenFromOutsideClients);

export const delegateTask = Effect.fn("j5.delegateTask")(function* (input: J5DelegateTaskInput) {
  const { persona: personaId, authorThreads, allow_once: allowOnce, ...delegate } = input;
  if (personaId === undefined) {
    const scope = yield* McpInvocationContext;
    const service = yield* OrchestratorMcpService;
    const memberModels = yield* CrewMemberModels;
    // A persona runs on its own model; a plain child, even one that inherits its parent's model,
    // runs on a model and level the project's lists allow. Upstream calls this with the model it
    // resolved.
    const delegated = service.delegateTask(scope, {
      ...delegate,
      authorizeTarget: ({ projectId, modelSelection }) =>
        memberModels.assertEligible({ projectId, selection: modelSelection }).pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "model_unavailable",
                message:
                  error._tag === "CrewMemberModelNotEligibleError"
                    ? `${error.message} Retry with target set to one of them as providerInstanceId and model.`
                    : `${error.message} Retry with target options setting the model's reasoning option to one of them.`,
              }),
          ),
        ),
    });
    // A delegate on another machine that did not answer is told when its line is back (D46).
    const remote = delegate.target?.environmentId;
    const unanswered = yield* Effect.serviceOption(UnreachableCalls);
    return yield* remote !== undefined && Option.isSome(unanswered)
      ? unanswered.value.observe(
          { threadId: scope.thread?.threadId, environmentId: remote, tool: "delegate_task" },
          delegated,
        )
      : delegated;
  }
  // A persona may name only the machine it runs on: it pins everything else itself.
  const { target, runtimeMode, ...personaDelegate } = delegate;
  if (
    runtimeMode !== undefined ||
    (target !== undefined &&
      (target.environmentId === undefined ||
        Object.keys(target).some((key) => key !== "environmentId" && key !== "projectId")))
  ) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "A persona pins its provider, model, reasoning, and runtime mode. Omit target and runtimeMode when passing persona, except target.environmentId to run it on a peered J5 machine.",
    });
  }
  const scope = yield* McpInvocationContext;
  const remote =
    target === undefined ? undefined : PeerForwarding.remoteTarget(scope, target.environmentId);
  // A project is named only for another machine; here a persona runs in its parent's project.
  if (target?.projectId !== undefined && remote === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "target.projectId with a persona names a project on another machine. Omit target to run the persona here, in your own project.",
    });
  if (target !== undefined && remote !== undefined) {
    return yield* delegatePersonaToPeer({
      ...personaDelegate,
      personaId,
      target: { ...target, environmentId: remote },
      ...(authorThreads === undefined ? {} : { authorThreads }),
      ...(allowOnce === undefined ? {} : { allowOnce }),
    });
  }
  return yield* invokeAgent({
    personaId,
    ...personaDelegate,
    ...(authorThreads === undefined ? {} : { authorThreads }),
    ...(allowOnce === undefined ? {} : { allowOnce }),
  });
});

/**
 * A persona delegated to a linked J5 machine, which resolves it from its own library against its
 * own models. Only J5 machines peer, and a plain T3 Code machine would run a plain delegate in its
 * place, so the machine must be peered. The pick's facts go with it; the machine holds the pick to
 * them and to the link's level.
 */
const delegatePersonaToPeer = Effect.fn("j5.delegatePersonaToPeer")(function* (
  input: Omit<J5DelegateTaskInput, "persona" | "authorThreads" | "allow_once" | "target"> & {
    readonly personaId: AgentPersonaId;
    readonly target: NonNullable<J5DelegateTaskInput["target"]> & {
      readonly environmentId: EnvironmentId;
    };
    readonly authorThreads?: ReadonlyArray<ThreadId>;
    readonly allowOnce?: string;
  },
) {
  const refuse = (message: string) =>
    Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message }));
  if (input.allowOnce !== undefined)
    return yield* refuse(
      "Allow this once lifts a block on this machine only; a persona blocked on another machine is unblocked there. Retry without allow_once, or run the persona here without target.",
    );
  const scope = yield* McpInvocationContext;
  const { thread } = yield* requireThreadScope(scope, "delegate_task");
  const environmentId = input.target.environmentId;
  const peered = yield* (yield* PeerRegistryService)
    .get(environmentId)
    .pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
      ),
    );
  if (peered === null)
    return yield* refuse(
      `This server is not peered with ${environmentId}. Only J5 machines peer, and a persona delegated to a machine that isn't one would run as a plain delegate instead. Peer the two machines, or run the persona here without target.`,
    );
  const parent = yield* (yield* ThreadManagementService)
    .getThreadRecords(thread.threadId, [])
    .pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
      ),
    );
  const pickFailure = (error: { readonly message: string }) =>
    new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
  const pickSource = yield* turnPickSource(thread.threadId, input.personaId).pipe(
    Effect.mapError(pickFailure),
  );
  const callerAccess = yield* resolveCallerAccess({ thread: parent.thread }).pipe(
    Effect.mapError(pickFailure),
  );
  // An independent reviewer's authors are threads here, so their models go in their place.
  const authors = yield* resolveReviewAuthors({
    projectId: parent.thread.projectId,
    threads:
      input.authorThreads === undefined
        ? [{ threadId: thread.threadId }]
        : input.authorThreads.map((threadId) => ({ threadId, named: true })),
  }).pipe(Effect.mapError(pickFailure));
  const { personaId, authorThreads: _authorThreads, allowOnce: _allowOnce, ...delegate } = input;
  const delegated = (yield* OrchestratorMcpService).delegateTask(scope, {
    ...delegate,
    title: input.title ?? personaId,
    mode: input.mode ?? "async",
    agentPersona: {
      personaId,
      delegated: {
        pickSource,
        callerAccess: {
          runtimeMode: callerAccess.runtimeMode,
          ...(callerAccess.sandbox === undefined ? {} : { sandbox: callerAccess.sandbox }),
        },
        authorModels: authors.models,
        authorsPartlyUnknown: authors.partlyUnknown,
      },
    },
  });
  // A delegate on another machine that did not answer is told when its line is back (D46).
  const unanswered = yield* Effect.serviceOption(UnreachableCalls);
  return yield* Option.isSome(unanswered)
    ? unanswered.value.observe(
        { threadId: thread.threadId, environmentId, tool: "delegate_task" },
        delegated,
      )
    : delegated;
});
