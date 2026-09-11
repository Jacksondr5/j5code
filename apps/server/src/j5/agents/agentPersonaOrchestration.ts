import type {
  CommandId,
  ModelSelection,
  OrchestrationV2AgentPersonaAssignment,
  OrchestrationV2AgentPersonaRequest,
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { validateAgentPersonaAssignment } from "./agentPersonaAssignment.ts";
import { prepareAgentPersonaLaunch } from "./agentPersonaLaunch.ts";
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
export const guardAgentPersonaThreadCreate = <E>(
  command: Extract<OrchestrationV2Command, { readonly type: "thread.create" }>,
  library: Library,
  driverFor: (instanceId: ProviderInstanceId) => Effect.Effect<string, E>,
): Effect.Effect<void, AgentPersonaLibraryError | E> =>
  Effect.gen(function* () {
    const assignment = command.agentPersonaAssignment;
    if (assignment === undefined) return;
    const definition = yield* library.readSnapshot(assignment).pipe(Effect.mapError(libraryError));
    const invalid = validateAgentPersonaAssignment(assignment, definition);
    if (invalid !== undefined) return yield* new AgentPersonaLibraryError({ message: invalid });
    if ((yield* driverFor(command.modelSelection.instanceId)) !== assignment.resolvedDriver) {
      return yield* new AgentPersonaLibraryError({
        message: "Agent persona assignment provider instance does not match its resolved driver.",
      });
    }
    if (!modelSelectionsEqual(command.modelSelection, assignment.resolvedModelSelection)) {
      return yield* new AgentPersonaLibraryError({
        message: "Agent persona assignment must match the thread model selection.",
      });
    }
  });

const immutableRoute = (thread: PersonaThread) =>
  `Agent persona thread ${thread.id} has an immutable model route.`;

/** Persona threads keep their launch route; explicit model or provider changes are rejected. */
export const agentPersonaRouteLockedError = (
  thread: PersonaThread,
  commandType: string,
): string | undefined =>
  thread.agentPersonaAssignment !== undefined &&
  (commandType === "thread.model-selection.set" || commandType === "provider.switch")
    ? immutableRoute(thread)
    : undefined;

/** A message carrying a different model selection than the resolved route is rejected too. */
export const agentPersonaModelMismatchError = (
  thread: PersonaThread,
  modelSelection: ModelSelection | undefined,
): string | undefined =>
  thread.agentPersonaAssignment !== undefined &&
  modelSelection !== undefined &&
  !modelSelectionsEqual(modelSelection, thread.agentPersonaAssignment.resolvedModelSelection)
    ? immutableRoute(thread)
    : undefined;

export interface AgentPersonaLaunch {
  readonly modelSelection: ModelSelection;
  readonly agentPersonaAssignment?: OrchestrationV2AgentPersonaAssignment;
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
      message: "Agent persona assignment requires a newly created thread.",
    });
  }
  if (options.replay) return requested;
  const agentPersonaAssignment = yield* prepareAgentPersonaLaunch(
    input.agentPersona,
    yield* options.providers,
    options.library,
  );
  const resolved: AgentPersonaLaunch = {
    modelSelection: agentPersonaAssignment.resolvedModelSelection,
    agentPersonaAssignment,
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
export const makeAgentPersonaGuards = <D, A, E>(deps: {
  readonly getDriver: (providerInstanceId: ProviderInstanceId) => Effect.Effect<string, E>;
  readonly adapterError: (
    command: CommandContext,
    providerInstanceId: ProviderInstanceId,
    cause: E,
  ) => A;
  readonly dispatchError: (command: CommandContext, cause: unknown) => D;
}) =>
  Effect.gen(function* () {
    const library = yield* makeAgentPersonaLibrary;
    const reject = (command: CommandContext, message: string | undefined) =>
      message === undefined ? Effect.void : Effect.fail(deps.dispatchError(command, message));
    return {
      library,
      /** `thread.create`: the assignment must be an intact snapshot on the resolved route. */
      threadCreate: (command: ThreadCreateCommand): Effect.Effect<void, D | A> =>
        guardAgentPersonaThreadCreate(command, library, (providerInstanceId) =>
          deps
            .getDriver(providerInstanceId)
            .pipe(
              Effect.mapError((cause) => deps.adapterError(command, providerInstanceId, cause)),
            ),
        ).pipe(
          Effect.catchIf(isLibraryError, (cause) =>
            Effect.fail(deps.dispatchError(command, cause)),
          ),
        ),
      /** Thread commands: explicit model or provider changes are rejected on persona threads. */
      routeLocked: (thread: PersonaThread, command: CommandContext): Effect.Effect<void, D> =>
        reject(command, agentPersonaRouteLockedError(thread, command.type)),
      /** Message dispatch: a different model selection than the resolved route is rejected. */
      modelMismatch: (
        thread: PersonaThread,
        command: CommandContext & { readonly modelSelection?: ModelSelection | undefined },
      ): Effect.Effect<void, D> =>
        reject(command, agentPersonaModelMismatchError(thread, command.modelSelection)),
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
