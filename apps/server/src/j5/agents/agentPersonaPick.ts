import {
  AgentPersonaPickConstraint,
  isAgentPersonaReasoningOptionId,
  type OrchestrationV2AgentPersonaCommandAssignment,
  type OrchestrationV2AppThread,
  type ProjectId,
  type ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { mentionedPersonaIds } from "@t3tools/shared/j5/agentMention";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { exceededDispatchModeLimit } from "../../orchestration-v2/DispatchModeLimit.ts";
import {
  latestActiveRun,
  ThreadManagementService,
} from "../../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { prepareAgentPersonaLaunch } from "./agentPersonaLaunch.ts";
import { makeAgentPersonaLibrary, type createAgentPersonaLibrary } from "./agentPersonaLibrary.ts";
import { translateAgentPersonaProviderPolicy } from "./agentPersonaProviderPolicy.ts";
import { resolveAgentPersonaRuntime } from "./agentPersonaRuntime.ts";
import { prepareAgentPersonaPeerSpawn } from "./agentPersonaSpawn.ts";
import type { AgentPersonaId } from "./agentPersonas.ts";
import { CrewMemberModels } from "./crewMemberModels.ts";

type Library = ReturnType<typeof createAgentPersonaLibrary>;

/** What an agent runs with: its runtime mode, and the persona sandbox that bounds it, if any. */
export interface AgentAccess {
  readonly runtimeMode: RuntimeMode;
  readonly sandbox?: "readOnly" | "workspaceWrite" | undefined;
}

/** Who launches the pick: an agent's thread, or an outside agent at its approved sign-in level. */
export type AgentPersonaPickCaller =
  | { readonly thread: Pick<OrchestrationV2AppThread, "agentPersonaAssignment" | "runtimeMode"> }
  | { readonly approvedLevel: RuntimeMode };

export type AgentPersonaPickSourceKind = "person" | "agent";

export class AgentPersonaPickError extends Schema.TaggedError<AgentPersonaPickError>()(
  "AgentPersonaPickError",
  {
    message: Schema.String,
    /** The limit that refused the pick, which "Allow this once" could waive; null for any other failure. */
    constraint: Schema.NullOr(AgentPersonaPickConstraint),
  },
) {}

// Upstream's dispatch limit owns the ordering of runtime modes; compare at equal interaction modes.
const broaderThan = (child: RuntimeMode, limit: RuntimeMode) =>
  exceededDispatchModeLimit(
    { runtimeMode: limit, interactionMode: "default" },
    { runtimeMode: child, interactionMode: "default" },
  ) !== undefined;

const RUNTIME_MODE_LABEL: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

// A persona's sandbox reads as the roster card and j5_list_personas name it; a plain mode by name.
const accessLabel = (access: AgentAccess) =>
  access.sandbox === "readOnly"
    ? "Read only"
    : access.sandbox === "workspaceWrite"
      ? "Repository write"
      : RUNTIME_MODE_LABEL[access.runtimeMode];

/** A persona's sandboxed policy or a plain runtime mode, as access. */
export const agentAccessOf = (policy: {
  readonly runtimeMode: RuntimeMode;
  readonly sandboxPolicy?: { readonly type: "readOnly" | "workspaceWrite" };
}): AgentAccess => ({ runtimeMode: policy.runtimeMode, sandbox: policy.sandboxPolicy?.type });

/** The caller's effective access: what its thread actually runs with, not its stored mode. */
const callerAccess = (caller: AgentPersonaPickCaller, library: Library) =>
  "approvedLevel" in caller
    ? Effect.succeed<AgentAccess>({ runtimeMode: caller.approvedLevel })
    : resolveAgentPersonaRuntime(caller.thread, library).pipe(
        Effect.map(agentAccessOf),
        Effect.mapError(
          (error) => new AgentPersonaPickError({ message: error.message, constraint: null }),
        ),
      );

/**
 * The access limit on anything an agent picks: never more than the caller runs with, and nothing
 * that writes from a read-only caller. `subject` names the worker, e.g. "Persona reviewer".
 */
export const assertWithinCallerAccess = Effect.fn("j5.agents.assertWithinCallerAccess")(function* (
  subject: string,
  child: AgentAccess,
  caller: AgentPersonaPickCaller,
) {
  const library = yield* makeAgentPersonaLibrary;
  const limit = yield* callerAccess(caller, library);
  if (
    !broaderThan(child.runtimeMode, limit.runtimeMode) &&
    (limit.sandbox !== "readOnly" || child.sandbox === "readOnly")
  )
    return;
  return yield* new AgentPersonaPickError({
    constraint: "access-above-caller",
    message: `${subject} would run with ${accessLabel(child)}, which is broader than the ${accessLabel(limit)} its caller runs with. An agent can only start workers within its own access.`,
  });
});

/** The caller's effective access as a runtime mode for a worker with no sandbox of its own. */
export const callerRuntimeMode = Effect.fn("j5.agents.callerRuntimeMode")(function* (
  caller: AgentPersonaPickCaller,
) {
  return (yield* callerAccess(caller, yield* makeAgentPersonaLibrary)).runtimeMode;
});

const libraryRefusal = (error: {
  readonly message: string;
  readonly constraint?: AgentPersonaPickConstraint | undefined;
}) => new AgentPersonaPickError({ message: error.message, constraint: error.constraint ?? null });

/**
 * The one launch check for a persona. A person's pick runs on its own models with its saved
 * access. An agent's pick skips entries outside the project's Models for custom members and is
 * refused when its access is broader than the caller's. A pinned entry (`j5_spawn_agent`) is held
 * to the same limits. The assignment records who picked.
 */
export const pickAgentPersona = Effect.fn("j5.agents.pickAgentPersona")(function* (input: {
  readonly personaId: AgentPersonaId;
  readonly source: AgentPersonaPickSourceKind;
  readonly caller: AgentPersonaPickCaller;
  readonly projectId: ProjectId;
  readonly pinned?: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    readonly reasoning?: string | undefined;
  };
  /** An access mode chosen for the worker in place of the persona's own (a Crew seat's). */
  readonly runtimeMode?: RuntimeMode | undefined;
}) {
  const library = yield* makeAgentPersonaLibrary;
  const providers = yield* (yield* ProviderRegistry).getProviders;
  const agentPick = input.source === "agent";
  const eligible = agentPick
    ? yield* (yield* CrewMemberModels).eligibility(input.projectId)
    : undefined;
  const pinned = input.pinned;
  const assignment: OrchestrationV2AgentPersonaCommandAssignment =
    pinned === undefined
      ? yield* prepareAgentPersonaLaunch(
          { personaId: input.personaId },
          providers,
          library,
          eligible,
        ).pipe(Effect.mapError(libraryRefusal))
      : yield* prepareAgentPersonaPeerSpawn(
          {
            personaId: input.personaId,
            provider: providers.find(({ instanceId }) => instanceId === pinned.instanceId),
            instanceId: pinned.instanceId,
            model: pinned.model,
            reasoning: pinned.reasoning,
          },
          library,
        ).pipe(Effect.mapError(libraryRefusal));
  const selection = assignment.resolvedModelSelection;
  const provider = providers.find(({ instanceId }) => instanceId === selection.instanceId);
  if (
    pinned !== undefined &&
    eligible !== undefined &&
    provider !== undefined &&
    !eligible(selection, provider)
  ) {
    const level = selection.options?.find(({ id }) => isAgentPersonaReasoningOptionId(id))?.value;
    return yield* new AgentPersonaPickError({
      constraint: "model-not-eligible",
      message: `Persona ${input.personaId} on ${selection.instanceId} ${selection.model}${level === undefined ? "" : ` (${String(level)})`} is not checked in Models for custom members, so an agent cannot pick it there.`,
    });
  }
  const policy = translateAgentPersonaProviderPolicy(
    assignment.authorityPolicy,
    assignment.resolvedDriver,
  );
  const access =
    input.runtimeMode === undefined ? agentAccessOf(policy) : { runtimeMode: input.runtimeMode };
  if (agentPick)
    yield* assertWithinCallerAccess(`Persona ${input.personaId}`, access, input.caller);
  return {
    assignment: { ...assignment, pickSource: { kind: input.source } },
    runtimeMode: access.runtimeMode,
  };
});

/**
 * Who picked a persona named in an agent's tool call: the person, when the message that started
 * the caller's current turn was typed by a person and mentions that persona unquoted. Anything
 * else (a relayed mention, a scheduled run, a steer into a running turn) is the agent's pick.
 */
export const turnPickSource = Effect.fn("j5.agents.turnPickSource")(function* (
  threadId: ThreadId,
  personaId: string,
) {
  const threads = yield* ThreadManagementService;
  const readFailed = (error: { readonly message: string }) =>
    new AgentPersonaPickError({
      message: `The turn that asked for persona ${personaId} could not be read: ${error.message}`,
      constraint: null,
    });
  const run = latestActiveRun(
    yield* threads.getThreadRecords(threadId, ["runs"]).pipe(Effect.mapError(readFailed)),
  );
  if (run === undefined) return "agent" as const;
  const { messages } = yield* threads
    .getThreadRecords(threadId, ["messages"], { messageIds: [run.userMessageId] })
    .pipe(Effect.mapError(readFailed));
  const message = messages[0];
  return message !== undefined &&
    message.createdBy === "user" &&
    (message.creationSource === "web" || message.creationSource === "mobile") &&
    mentionedPersonaIds(message.text).includes(personaId)
    ? ("person" as const)
    : ("agent" as const);
});
