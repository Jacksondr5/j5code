import {
  AgentPersonaBlockCode,
  AgentPersonaPickConstraint,
  isAgentPersonaReasoningOptionId,
  type ProviderDriverKind,
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
import {
  AgentPersonaEscalations,
  AgentPersonaWaiverScope,
  personaBlockText,
} from "./agentPersonaEscalation.ts";
import { prepareAgentPersonaLaunch } from "./agentPersonaLaunch.ts";
import {
  definitionDigest,
  makeAgentPersonaLibrary,
  type createAgentPersonaLibrary,
} from "./agentPersonaLibrary.ts";
import { translateAgentPersonaProviderPolicy } from "./agentPersonaProviderPolicy.ts";
import { resolveAgentPersonaRuntime } from "./agentPersonaRuntime.ts";
import {
  agentPersonaLimitFailures,
  type AgentPersonaEntryEligibility,
  type AgentPersonaPickLimits,
} from "./agentPersonaRouting.ts";
import { prepareAgentPersonaPeerSpawn } from "./agentPersonaSpawn.ts";
import {
  agentPersonaPolicy,
  type AgentPersonaDefinition,
  type AgentPersonaId,
} from "./agentPersonas.ts";
import { CrewMemberModels } from "./crewMemberModels.ts";
import {
  resolveReviewAuthors,
  reviewIndependenceOf,
  type ReviewAuthorsRequest,
} from "./agentPersonaReviewIndependence.ts";

type Library = ReturnType<typeof createAgentPersonaLibrary>;

/** What an agent runs with: its runtime mode, and the persona sandbox that bounds it, if any. */
export interface AgentAccess {
  readonly runtimeMode: RuntimeMode;
  readonly sandbox?: "readOnly" | "workspaceWrite" | undefined;
}

/**
 * Who launches the pick: an agent's thread, an outside agent at its approved sign-in level, or
 * access already resolved for a caller that picks several times (a Crew's Captain).
 */
export type AgentPersonaPickCaller =
  | { readonly thread: Pick<OrchestrationV2AppThread, "agentPersonaAssignment" | "runtimeMode"> }
  | { readonly approvedLevel: RuntimeMode }
  | { readonly access: AgentAccess };

export type AgentPersonaPickSourceKind = "person" | "agent";

export class AgentPersonaPickError extends Schema.TaggedError<AgentPersonaPickError>()(
  "AgentPersonaPickError",
  {
    message: Schema.String,
    /** The one limit "Allow this once" could waive to let the pick run; null for any other failure. */
    constraint: Schema.NullOr(AgentPersonaPickConstraint),
    /** Why the persona was refused; absent when the failure is not the persona's, such as bad input. */
    code: Schema.optional(AgentPersonaBlockCode),
    /** The escalation recorded for the refusal; absent for an outside agent, which can't ask. */
    escalationId: Schema.optional(Schema.String),
    /** With `constraint`: the launch a grant of it would allow. */
    scope: Schema.optional(AgentPersonaWaiverScope),
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
export const resolveCallerAccess = Effect.fn("j5.agents.resolveCallerAccess")(function* (
  caller: AgentPersonaPickCaller,
) {
  if ("access" in caller) return caller.access;
  if ("approvedLevel" in caller) return { runtimeMode: caller.approvedLevel } satisfies AgentAccess;
  return yield* resolveAgentPersonaRuntime(caller.thread, yield* makeAgentPersonaLibrary).pipe(
    Effect.map(agentAccessOf),
    Effect.mapError(
      (error) => new AgentPersonaPickError({ message: error.message, constraint: null }),
    ),
  );
});

/** Never more than the caller runs with, and nothing that writes from a read-only caller. */
const withinAccess = (child: AgentAccess, limit: AgentAccess) =>
  !broaderThan(child.runtimeMode, limit.runtimeMode) &&
  (limit.sandbox !== "readOnly" || child.sandbox === "readOnly");

/**
 * The access limit on anything an agent picks. `subject` names the worker, e.g. "Custom seat
 * reviewer".
 */
export const assertWithinCallerAccess = Effect.fn("j5.agents.assertWithinCallerAccess")(function* (
  subject: string,
  child: AgentAccess,
  caller: AgentPersonaPickCaller,
) {
  const limit = yield* resolveCallerAccess(caller);
  if (withinAccess(child, limit)) return;
  return yield* new AgentPersonaPickError({
    constraint: "access-above-caller",
    message: `${subject} would run with ${accessLabel(child)}, which is broader than the ${accessLabel(limit)} its caller runs with. An agent can only start workers within its own access.`,
  });
});

const libraryRefusal = (error: {
  readonly message: string;
  readonly constraint?: AgentPersonaPickConstraint | undefined;
  readonly code?: AgentPersonaBlockCode | undefined;
}) =>
  new AgentPersonaPickError({
    message: error.message,
    constraint: error.constraint ?? null,
    ...(error.code === undefined ? {} : { code: error.code }),
  });

/**
 * The authors of the work an independent reviewer reviews; undefined for any other persona, whose
 * launch reads no threads, and for a disabled or unknown one, which the launch refuses for that.
 * A named author thread that does not exist, or is in another project, is refused as bad input.
 */
const reviewAuthorsFor = Effect.fn("j5.agents.reviewAuthorsFor")(function* (
  personaId: AgentPersonaId,
  request: ReviewAuthorsRequest | undefined,
  catalog: {
    readonly definitions: ReadonlyArray<AgentPersonaDefinition>;
    readonly disabledIds: ReadonlyArray<string>;
  },
  projectId: ProjectId,
) {
  if (
    request === undefined ||
    catalog.disabledIds.includes(personaId) ||
    catalog.definitions.find(({ id }) => id === personaId)?.independentReviewer !== true
  )
    return undefined;
  return yield* resolveReviewAuthors({ ...request, projectId }).pipe(
    Effect.mapError(
      (error) =>
        new AgentPersonaPickError({
          message:
            error._tag === "ReviewAuthorThreadRefusedError"
              ? `${error.message} Name author threads in this project that exist, or omit them to review your own work.`
              : `The authors of the work under review could not be read: ${error.message}`,
          constraint: null,
        }),
    ),
  );
});

export interface AgentPersonaPickInput {
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
  /** The project's lists, already read by a caller that picks several times. */
  readonly eligible?: AgentPersonaEntryEligibility | undefined;
  /** Whose work an independent reviewer reviews; read only when the persona is flagged as one. */
  readonly reviewAuthors?: ReviewAuthorsRequest | undefined;
  /** The participant a refusal escalates for; an outside agent, which can't ask, has none. */
  readonly escalateFor?: string | undefined;
  /** A granted escalation of this caller's for this persona. */
  readonly allowOnce?: string | undefined;
}

/**
 * The one launch check for a persona. An agent's pick skips entries outside Models for custom
 * members or broader than the caller's access; a pin is a list of one. A refusal escalates for
 * `escalateFor`; a granted `allowOnce` lifts one limit, and the caller spends it on launch.
 */
export const pickAgentPersona = Effect.fn("j5.agents.pickAgentPersona")(function* (
  input: AgentPersonaPickInput,
) {
  const escalations = yield* AgentPersonaEscalations;
  const agentPick = input.source === "agent";
  // A person's pick has no limits to lift, so it neither checks nor spends a grant.
  const grant =
    input.allowOnce === undefined || !agentPick
      ? undefined
      : yield* escalations
          .grantedWaiver({
            escalationId: input.allowOnce,
            callerParticipantId: input.escalateFor,
            personaId: input.personaId,
          })
          .pipe(
            Effect.mapError(
              (error) => new AgentPersonaPickError({ message: error.message, constraint: null }),
            ),
          );
  // A refusal about the persona is recorded for the caller and told in the one text form.
  const escalate = Effect.fn("j5.agents.pickAgentPersona.escalate")(function* (
    error: AgentPersonaPickError,
  ) {
    if (error.code === undefined) return yield* error;
    const code = error.code;
    // A waiver is offered only for a launch whose scope can be recorded.
    const waivable = error.scope === undefined ? null : error.constraint;
    const unspent =
      grant === undefined
        ? ""
        : ` allow_once ${input.allowOnce} covers only ${describeScope(grant.scope)}, so it stays unspent for that.`;
    const escalationId =
      input.escalateFor === undefined
        ? null
        : yield* escalations
            .record({
              callerParticipantId: input.escalateFor,
              personaId: input.personaId,
              code,
              summary: error.message,
              waivable,
              scope: waivable === null ? null : (error.scope ?? null),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new AgentPersonaPickError({
                    message: `${error.message} Its escalation could not be recorded: ${cause.message}`,
                    constraint: null,
                    code,
                  }),
              ),
            );
    return yield* new AgentPersonaPickError({
      message: personaBlockText({
        code,
        detail: `${error.message}${unspent}`,
        escalationId,
        waivable,
      }),
      constraint: waivable,
      code,
      ...(escalationId === null ? {} : { escalationId }),
    });
  });
  return yield* pickWithin(input, grant).pipe(
    Effect.catchTags({ AgentPersonaPickError: escalate }),
    Effect.map(({ waived, ...picked }) =>
      waived === undefined
        ? picked
        : {
            ...picked,
            assignment: {
              ...picked.assignment,
              pickSource: { kind: "allow-once" as const, waived },
            },
          },
    ),
  );
});

const describeScope = (scope: AgentPersonaWaiverScope) =>
  scope.entries
    .map((entry) => `${entry.instanceId} ${entry.model} at ${accessLabel(entry)}`)
    .join(" or ");

const pickWithin = Effect.fn("j5.agents.pickWithin")(function* (
  input: AgentPersonaPickInput,
  grant:
    | { readonly constraint: AgentPersonaPickConstraint; readonly scope: AgentPersonaWaiverScope }
    | undefined,
) {
  const sources = yield* makeAgentPersonaLibrary;
  const catalog = yield* sources.catalog().pipe(
    Effect.mapError(
      (error) =>
        new AgentPersonaPickError({
          code: "library_unreadable",
          message: `The persona library cannot be read: ${error.message}`,
          constraint: null,
        }),
    ),
  );
  // One read serves the reviewer flag and the launch, so an edit between them can't split them.
  const library: Library = { ...sources, catalog: () => Effect.succeed(catalog) };
  const definition = catalog.definitions.find(({ id }) => id === input.personaId);
  const digest = definition === undefined ? undefined : definitionDigest(definition);
  if (grant !== undefined && digest !== undefined && digest !== grant.scope.definitionDigest)
    return yield* new AgentPersonaPickError({
      message: `allow_once ${input.allowOnce} was granted under an earlier version of persona ${input.personaId}'s definition, so it no longer applies; it stays unspent. Ask the person again.`,
      constraint: null,
    });
  const covers = (selection: { readonly instanceId: string; readonly model: string }) =>
    grant?.scope.entries.find(
      (entry) => entry.instanceId === selection.instanceId && entry.model === selection.model,
    );
  const providers = yield* (yield* ProviderRegistry).getProviders;
  const authors = yield* reviewAuthorsFor(
    input.personaId,
    input.reviewAuthors,
    catalog,
    input.projectId,
  );
  const agentPick = input.source === "agent";
  const accessOn = (
    authority: OrchestrationV2AgentPersonaCommandAssignment["authorityPolicy"],
    driver: ProviderDriverKind,
  ): AgentAccess =>
    input.runtimeMode === undefined
      ? agentAccessOf(translateAgentPersonaProviderPolicy(authority, driver))
      : { runtimeMode: input.runtimeMode };
  const limit = agentPick ? yield* resolveCallerAccess(input.caller) : undefined;
  const limits: AgentPersonaPickLimits | undefined =
    limit === undefined
      ? undefined
      : {
          eligible:
            input.eligible ?? (yield* (yield* CrewMemberModels).eligibility(input.projectId)),
          accessAbove: (authority, driver) => {
            const child = accessOn(authority, driver);
            return withinAccess(child, limit)
              ? undefined
              : `on ${driver} it would run with ${accessLabel(child)}, which is broader than the ${accessLabel(limit)} its caller runs with`;
          },
          waived:
            grant === undefined
              ? undefined
              : {
                  constraint: grant.constraint,
                  covers: (selection) => covers(selection) !== undefined,
                },
        };
  // What a refusal waivable by one limit would let run, recorded so a grant allows only that.
  const scopeOf = (
    entries: ReadonlyArray<{
      readonly entryIndex: number;
      readonly instanceId: string;
      readonly model: string;
    }>,
  ): AgentPersonaWaiverScope | undefined =>
    definition === undefined || digest === undefined
      ? undefined
      : {
          definitionDigest: digest,
          entries: entries.flatMap((entry) => {
            const driver = providers.find(
              ({ instanceId }) => instanceId === entry.instanceId,
            )?.driver;
            return driver === undefined
              ? []
              : [{ ...entry, ...accessOn(agentPersonaPolicy(definition), driver) }];
          }),
        };
  const launchRefusal = (error: {
    readonly message: string;
    readonly constraint?: AgentPersonaPickConstraint | undefined;
    readonly code?: AgentPersonaBlockCode | undefined;
    readonly waiverEntries?:
      | ReadonlyArray<{
          readonly entryIndex: number;
          readonly instanceId: string;
          readonly model: string;
        }>
      | undefined;
  }) => {
    const scope = error.waiverEntries === undefined ? undefined : scopeOf(error.waiverEntries);
    return new AgentPersonaPickError({
      message: error.message,
      constraint: error.constraint ?? null,
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(scope === undefined ? {} : { scope }),
    });
  };
  const pinned = input.pinned;
  const assignment: OrchestrationV2AgentPersonaCommandAssignment =
    pinned === undefined
      ? yield* prepareAgentPersonaLaunch(
          { personaId: input.personaId },
          providers,
          library,
          limits,
          authors === undefined ? undefined : new Set(authors.models),
        ).pipe(Effect.mapError(launchRefusal))
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
  const access = accessOn(assignment.authorityPolicy, assignment.resolvedDriver);
  const provider = providers.find(({ instanceId }) => instanceId === selection.instanceId);
  if (pinned !== undefined && limit !== undefined && provider !== undefined) {
    // A pin is a list of one: a limit it fails refuses it, and nothing else is tried.
    const failures = agentPersonaLimitFailures(
      limits,
      assignment.authorityPolicy,
      selection,
      provider,
    );
    if (failures.length > 0) {
      const level = selection.options?.find(({ id }) => isAgentPersonaReasoningOptionId(id))?.value;
      const subject = `Persona ${input.personaId} on ${selection.instanceId} ${selection.model}${level === undefined ? "" : ` (${String(level)})`}`;
      const scope =
        failures.length === 1
          ? scopeOf([
              {
                entryIndex: assignment.resolvedEntryIndex ?? 0,
                instanceId: selection.instanceId,
                model: selection.model,
              },
            ])
          : undefined;
      return yield* new AgentPersonaPickError({
        code: "models_exhausted",
        constraint: failures.length === 1 ? failures[0]!.code : null,
        ...(scope === undefined ? {} : { scope }),
        message: `${subject} is blocked: ${failures
          .map(({ code, detail }) =>
            code === "model-not-eligible"
              ? "it is not checked in Models for custom members, so an agent cannot pick it there"
              : detail,
          )
          .join("; ")}.`,
      });
    }
  }
  // A grant lets through only the candidate it covered, at no more than the access recorded.
  const covered = covers(selection);
  if (covered !== undefined && !withinAccess(access, covered))
    return yield* new AgentPersonaPickError({
      message: `allow_once ${input.allowOnce} covered persona ${input.personaId} on ${covered.instanceId} ${covered.model} at ${accessLabel(covered)}; this launch asks for ${accessLabel(access)}, so the allowance stays unspent. Ask the person again for that.`,
      constraint: null,
    });
  return {
    waived: covered === undefined ? undefined : grant?.constraint,
    assignment: {
      ...assignment,
      pickSource: { kind: input.source },
      // A pinned model is the agent's choice, so it is noted rather than reordered.
      ...(authors === undefined
        ? {}
        : {
            reviewIndependence: reviewIndependenceOf(
              authors,
              selection.model,
              pinned === undefined ? "server" : "agent",
            ),
          }),
    },
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
