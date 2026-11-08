import {
  isAgentPersonaAuthorityPolicy,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type CommandId,
  type ModelSelection,
  type OrchestrationV2AgentPersonaAssignment,
  type OrchestrationV2AgentPersonaCommandAssignment,
  type OrchestrationV2AgentPersonaRequest,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { validateAgentPersonaAssignment } from "./agentPersonaAssignment.ts";
import { prepareAgentPersonaLaunch, routeFailurePhrase } from "./agentPersonaLaunch.ts";
import {
  agentPersonaPolicyEnforcement,
  providerCanEnforceAgentPersonaAuthority,
} from "./agentPersonaProviderPolicy.ts";
import {
  agentPersonaEntryMatches,
  agentPersonaTargetUnavailableReason,
} from "./agentPersonaRouting.ts";
import { mapAgentPersonaPolicy } from "./agentPersonas.ts";
import { validateAgentPersonaSubagent } from "./agentPersonaSubagent.ts";
import {
  AgentPersonaLibraryError,
  makeAgentPersonaLibrary,
  type createAgentPersonaLibrary,
} from "./agentPersonaLibrary.ts";

type Library = ReturnType<typeof createAgentPersonaLibrary>;
type PersonaThread = Pick<OrchestrationV2AppThread, "id" | "agentPersonaAssignment">;

const isLibraryError = Schema.is(AgentPersonaLibraryError);
const libraryError = (cause: unknown) =>
  isLibraryError(cause) ? cause : new AgentPersonaLibraryError({ message: String(cause), cause });

/**
 * `thread.create` guard: a persona assignment must reference an intact snapshot, the
 * selected provider instance must run the resolved driver, and the model selection must
 * be the resolved route. Failures surface as `AgentPersonaLibraryError`; `driverFor`
 * errors pass through untouched.
 */
export const guardAgentPersonaThreadCreate = Effect.fn(
  "j5.agents.agentPersonaOrchestration.guardAgentPersonaThreadCreate",
)(function* <E>(
  command: Extract<OrchestrationV2Command, { readonly type: "thread.create" }>,
  library: Library,
  driverFor: (instanceId: ProviderInstanceId) => Effect.Effect<string, E>,
): Effect.fn.Return<void, AgentPersonaLibraryError | E> {
  const assignment = command.agentPersonaAssignment;
  if (assignment === undefined) return;
  const definition = yield* library.readSnapshot(assignment).pipe(Effect.mapError(libraryError));
  const invalid = validateAgentPersonaAssignment(assignment, definition);
  if (invalid !== undefined) return yield* new AgentPersonaLibraryError({ message: invalid });
  if ((yield* driverFor(command.modelSelection.instanceId)) !== assignment.resolvedDriver) {
    return yield* new AgentPersonaLibraryError({
      message: "Persona assignment provider instance does not match its resolved driver.",
    });
  }
  if (!modelSelectionsEqual(command.modelSelection, assignment.resolvedModelSelection)) {
    return yield* new AgentPersonaLibraryError({
      message: "Persona assignment must match the thread model selection.",
    });
  }
});

/**
 * Marks a command a person sent from a client (`CommandAdmission`), and carries the providers the
 * switch checks read. Absent on every agent, MCP, scheduled and service path, so their model
 * changes on a persona thread are refused.
 */
export const AgentPersonaModelSwitch = Context.Reference<
  { readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>> } | undefined
>("j5/agents/AgentPersonaModelSwitch", { defaultValue: () => undefined });

export const AGENT_MODEL_SWITCH_REFUSAL =
  "Agents can't change a persona worker's model. Replace the worker instead: start a new one with the model you want, or as a Captain add a member.";

const ACCESS_LABELS: Record<string, string> = {
  "read-only": "Read-only",
  "workspace-write": "Workspace-write",
  "full-access": "Full-access",
};

const driverLabel = (driver: string) =>
  PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make(driver)] ?? driver;

/** Why a person's switch to `selection` is refused, or undefined when it may run. */
const agentPersonaSwitchRefusal = (
  assignment: OrchestrationV2AgentPersonaAssignment,
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
  now: number,
): string | undefined => {
  const stays = "The worker stays on its current model.";
  const provider = providers.find(({ instanceId }) => instanceId === selection.instanceId);
  if (provider === undefined)
    return `No signed-in provider offers ${selection.model} on ${selection.instanceId}. ${stays}`;
  // A Crew seat's human-approved runtime mode replaces the persona's sandbox, as at runtime.
  if (
    assignment.runtimeModeOverride === undefined &&
    !providerCanEnforceAgentPersonaAuthority(provider.driver, assignment.authorityPolicy)
  ) {
    const access = isAgentPersonaAuthorityPolicy(assignment.authorityPolicy)
      ? mapAgentPersonaPolicy(assignment.authorityPolicy)
      : assignment.authorityPolicy;
    const enforcing =
      agentPersonaPolicyEnforcement().find(({ policy }) => policy === access)?.drivers ?? [];
    return `${driverLabel(provider.driver)} can't enforce ${ACCESS_LABELS[access] ?? access} access, which this persona runs with.${enforcing.length === 0 ? "" : ` Pick a model on ${enforcing.map(driverLabel).join(" or ")}.`} ${stays}`;
  }
  const unavailable = agentPersonaTargetUnavailableReason(provider, selection, now);
  if (unavailable === undefined) return undefined;
  const phrase = routeFailurePhrase(selection, { code: unavailable }, driverLabel(provider.driver));
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}. ${stays}`;
};

/** The assignment after a switch: the model fields follow; the snapshot, access and pick stay. */
const switchedAgentPersonaAssignment = (
  assignment: OrchestrationV2AgentPersonaAssignment,
  selection: ModelSelection,
  driver: string,
  modelRoute: ReadonlyArray<Parameters<typeof agentPersonaEntryMatches>[0]>,
): OrchestrationV2AgentPersonaAssignment => {
  const { resolvedEntryIndex: _previous, ...rest } = assignment;
  const entryIndex = modelRoute.findIndex((entry) =>
    agentPersonaEntryMatches(entry, selection, driver),
  );
  return {
    ...rest,
    resolvedRoute: "override",
    ...(entryIndex === -1 ? {} : { resolvedEntryIndex: entryIndex }),
    resolvedDriver: ProviderDriverKind.make(driver),
    resolvedModelSelection: selection,
    modelSwitchedBy: "person",
  };
};

type ThreadEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly payload: OrchestrationV2AppThread }
>;
const isSelectionEvent = (
  event: Omit<OrchestrationV2DomainEvent, "id">,
): event is Omit<ThreadEvent, "id"> =>
  event.type === "thread.model-selection-updated" || event.type === "thread.provider-switched";

export interface AgentPersonaLaunch {
  readonly modelSelection: ModelSelection;
  readonly agentPersonaAssignment?: OrchestrationV2AgentPersonaCommandAssignment;
}

/**
 * Resolve the persona route before the durable create. Replays (a launch receipt exists)
 * keep the requested selection; the stored create event is the source of truth then.
 */
export const resolveAgentPersonaLaunch = Effect.fn("j5.resolveAgentPersonaLaunch")(function* (
  input: {
    readonly reuseExistingThread?: boolean | undefined;
    readonly agentPersona?: OrchestrationV2AgentPersonaRequest | undefined;
    readonly modelSelection: ModelSelection;
  },
  options: {
    readonly replay: boolean;
    readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
    readonly library: Library;
  },
) {
  const requested: AgentPersonaLaunch = { modelSelection: input.modelSelection };
  if (input.agentPersona === undefined) return requested;
  if (input.reuseExistingThread === true) {
    return yield* new AgentPersonaLibraryError({
      message: "Persona assignment requires a newly created thread.",
    });
  }
  if (options.replay) return requested;
  const prepared = yield* prepareAgentPersonaLaunch(
    input.agentPersona,
    yield* options.providers,
    options.library,
  );
  // The composer's persona launch is always a person's pick, which has no limits to apply.
  const resolved: AgentPersonaLaunch = {
    modelSelection: prepared.resolvedModelSelection,
    agentPersonaAssignment: { ...prepared, pickSource: { kind: "person" } },
  };
  return resolved;
});

/** After the durable create, the stored event's selection wins over the requested one. */
export const durableLaunchModelSelection = (
  storedEvents: ReadonlyArray<{ readonly event: OrchestrationV2DomainEvent }>,
  fallback: ModelSelection,
): ModelSelection => {
  const created = storedEvents.find((stored) => stored.event.type === "thread.created")?.event;
  return created?.type === "thread.created" ? created.payload.modelSelection : fallback;
};

type CommandContext = { readonly commandId: CommandId; readonly type: string };
type ThreadCreateCommand = Extract<OrchestrationV2Command, { readonly type: "thread.create" }>;

/**
 * Guards for the upstream orchestrator, built once next to its other services. The upstream
 * file supplies only its two error constructors and the adapter lookup; every call site is a
 * single `yield*`. Failures use the orchestrator's own error types so dispatch semantics do
 * not change.
 */
export const makeAgentPersonaGuards = Effect.fn(
  "j5.agents.agentPersonaOrchestration.makeAgentPersonaGuards",
)(function* <D, A, E>(deps: {
  readonly getDriver: (providerInstanceId: ProviderInstanceId) => Effect.Effect<string, E>;
  readonly adapterError: (
    command: CommandContext,
    providerInstanceId: ProviderInstanceId,
    cause: E,
  ) => A;
  readonly dispatchError: (command: CommandContext, cause: unknown) => D;
}) {
  const library = yield* makeAgentPersonaLibrary;
  const reject = (command: CommandContext, message: string | undefined) =>
    message === undefined ? Effect.void : Effect.fail(deps.dispatchError(command, message));
  const checkSwitch = Effect.fnUntraced(function* (
    thread: PersonaThread,
    command: CommandContext & { readonly modelSelection?: ModelSelection | undefined },
  ) {
    const assignment = thread.agentPersonaAssignment;
    const selection = command.modelSelection;
    if (
      assignment === undefined ||
      selection === undefined ||
      modelSelectionsEqual(selection, assignment.resolvedModelSelection)
    )
      return;
    const person = yield* AgentPersonaModelSwitch;
    if (person === undefined) return yield* reject(command, AGENT_MODEL_SWITCH_REFUSAL);
    const providers = yield* person.providers;
    const now = yield* Clock.currentTimeMillis;
    yield* reject(command, agentPersonaSwitchRefusal(assignment, selection, providers, now));
  });
  return {
    library,
    /** `thread.create`: the assignment must be an intact snapshot on the resolved route. */
    threadCreate: (command: ThreadCreateCommand): Effect.Effect<void, D | A> =>
      guardAgentPersonaThreadCreate(command, library, (providerInstanceId) =>
        deps
          .getDriver(providerInstanceId)
          .pipe(Effect.mapError((cause) => deps.adapterError(command, providerInstanceId, cause))),
      ).pipe(
        Effect.catchIf(isLibraryError, (cause) => Effect.fail(deps.dispatchError(command, cause))),
      ),
    /** Thread commands: a model or provider change is a person's alone, and is checked again. */
    modelChange: (
      thread: PersonaThread,
      command: CommandContext & { readonly modelSelection?: ModelSelection | undefined },
    ): Effect.Effect<void, D> =>
      command.type === "thread.model-selection.set" || command.type === "provider.switch"
        ? checkSwitch(thread, command)
        : Effect.void,
    /** Message dispatch: a selection other than the current one is a switch, checked the same way. */
    modelMismatch: (
      thread: PersonaThread,
      command: CommandContext & { readonly modelSelection?: ModelSelection | undefined },
    ): Effect.Effect<void, D> => checkSwitch(thread, command),
    /**
     * Every event that changes a persona thread's selection carries the switched assignment, so
     * the chip, the composer and the runtime read the model the thread actually runs on.
     */
    followModelSelection: Effect.fnUntraced(function* <
      Event extends Omit<OrchestrationV2DomainEvent, "id">,
    >(event: Event) {
      if (!isSelectionEvent(event)) return event;
      const thread = event.payload;
      const assignment = thread.agentPersonaAssignment;
      if (
        assignment === undefined ||
        modelSelectionsEqual(thread.modelSelection, assignment.resolvedModelSelection)
      )
        return event;
      const driver = yield* deps.getDriver(thread.modelSelection.instanceId);
      const definition = yield* library
        .readSnapshot(assignment)
        .pipe(Effect.mapError(libraryError));
      const switched = switchedAgentPersonaAssignment(
        assignment,
        thread.modelSelection,
        driver,
        definition.modelRoute,
      );
      return { ...event, payload: { ...thread, agentPersonaAssignment: switched } } as Event;
    }),
    /** Delegated child: an explicit assignment must match the child's provider and route. */
    subagent: (
      command: CommandContext & {
        readonly agentPersonaAssignment?: OrchestrationV2AgentPersonaAssignment | undefined;
        readonly modelSelection: ModelSelection;
      },
      driver: string,
    ): Effect.Effect<void, D> =>
      validateAgentPersonaSubagent(command, library, driver).pipe(
        Effect.mapError((cause) => deps.dispatchError(command, cause)),
      ),
  };
});
