import {
  CommandId,
  type EnvironmentId,
  type ThreadId,
  type ExecutionEnvironmentCapabilities,
} from "@t3tools/contracts";
import {
  J5ActionError,
  J5_ACCESS_WS_METHODS,
  J5_THREAD_READ_WS_METHODS,
  type PersonalThreadReadChange,
} from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { getInitialServerConfig, subscribe } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "../state/runtime.ts";
import {
  visitThread,
  markThreadUnread,
  type VisitThreadInput,
  type MarkThreadUnreadInput,
} from "../operations/commands.ts";

type PersonalReadMarkers = ReadonlyMap<ThreadId, DateTime.Utc>;
export type PersonalReadMarkersAtom = (
  environmentId: EnvironmentId,
) => Atom.Atom<PersonalReadMarkers | undefined>;
const EMPTY_MARKERS: PersonalReadMarkers = new Map();

function applyPersonalReadChange(
  markers: PersonalReadMarkers,
  change: PersonalThreadReadChange,
): PersonalReadMarkers {
  if (change.kind === "snapshot")
    return new Map(change.markers.map((marker) => [marker.threadId, marker.lastVisitedAt]));
  return new Map(markers).set(change.marker.threadId, change.marker.lastVisitedAt);
}

export function createPersonalThreadReadAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const state = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "j5-personal-thread-reads",
    subscribe: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          let personId: string | undefined;
          return SubscriptionRef.changes(supervisor.session).pipe(
            Stream.switchMap(
              Option.match({
                onNone: () => Stream.empty,
                onSome: (session) =>
                  Stream.unwrap(
                    Effect.gen(function* () {
                      const config = yield* session.initialConfig;
                      if (config.environment.capabilities.j5PersonalThreadReads !== true) {
                        personId = undefined;
                        return Stream.succeed(undefined);
                      }
                      const access = yield* session.client[
                        J5_ACCESS_WS_METHODS.getConnectionAccess
                      ]({});
                      const nextPerson = access.kind === "person" ? access.personId : undefined;
                      const changedPerson = nextPerson !== personId || nextPerson === undefined;
                      personId = nextPerson;
                      const updates = subscribe(J5_THREAD_READ_WS_METHODS.subscribe, {}).pipe(
                        Stream.scan(() => EMPTY_MARKERS, applyPersonalReadChange),
                        Stream.drop(1),
                      );
                      return changedPerson
                        ? Stream.concat(Stream.succeed(undefined), updates)
                        : updates;
                    }),
                  ),
              }),
            ),
          );
        }),
      ),
    idleTtlMs: 0,
  });
  const markersAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(
        AsyncResult.value(get(state({ environmentId, input: undefined }))),
        () => undefined,
      ),
    ),
  );
  return { markersAtom };
}

type ReadCommandIdentity =
  | { readonly commandId?: never; readonly issuedAt?: never }
  | { readonly commandId: CommandId; readonly issuedAt: string };
type ReadCommandInput<T> = Omit<T, "commandId"> & ReadCommandIdentity;

const readCommandIdentity = Effect.fn("PersonalThreadReads.identity")(function* (
  input: ReadCommandIdentity,
) {
  if (input.commandId !== undefined) {
    if (input.issuedAt === undefined)
      return yield* new J5ActionError({
        code: "invalid_request",
        message: "A retried read command needs its original issuance time.",
      });
    return { commandId: input.commandId, issuedAt: input.issuedAt };
  }
  return {
    commandId: CommandId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4()),
    issuedAt: DateTime.formatIso(yield* DateTime.now),
  };
});

export function createPersonalThreadReadCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | SecureRandom.SecureRandom | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      environmentId: EnvironmentId;
      input: { threadId: ThreadId };
    }) => `${environmentId}:${input.threadId}`,
  };
  const visit = createEnvironmentRpcCommand(runtime, {
    label: "j5-thread-read:visit",
    tag: J5_THREAD_READ_WS_METHODS.visit,
  });
  const markUnread = createEnvironmentRpcCommand(runtime, {
    label: "j5-thread-read:unread",
    tag: J5_THREAD_READ_WS_METHODS.markUnread,
  });
  return {
    visit: {
      ...createEnvironmentCommand(runtime, {
        scheduler,
        concurrency,
        label: "environment-data:commands:thread:visit",
        execute: Effect.fn("PersonalThreadReads.visit")(function* (
          input: ReadCommandInput<VisitThreadInput>,
          registry: AtomRegistry.AtomRegistry,
          environmentId: EnvironmentId,
        ) {
          const config = yield* getInitialServerConfig();
          if (config.environment.capabilities.j5PersonalThreadReads !== true)
            return yield* visitThread(input).pipe(Effect.asVoid);
          const { commandId, issuedAt } = yield* readCommandIdentity(input);
          const result = yield* Effect.promise(() =>
            visit.run(registry, { environmentId, input: { ...input, commandId, issuedAt } }),
          );
          if (AsyncResult.isFailure(result)) return yield* Effect.failCause(result.cause);
        }),
      }),
      permissionAtom: visit.permissionAtom,
    },
    markUnread: {
      ...createEnvironmentCommand(runtime, {
        scheduler,
        concurrency,
        label: "environment-data:commands:thread:mark-unread",
        execute: Effect.fn("PersonalThreadReads.markUnread")(function* (
          input: ReadCommandInput<MarkThreadUnreadInput>,
          registry: AtomRegistry.AtomRegistry,
          environmentId: EnvironmentId,
        ) {
          const config = yield* getInitialServerConfig();
          if (config.environment.capabilities.j5PersonalThreadReads !== true)
            return yield* markThreadUnread(input).pipe(Effect.asVoid);
          const { commandId, issuedAt } = yield* readCommandIdentity(input);
          const result = yield* Effect.promise(() =>
            markUnread.run(registry, { environmentId, input: { ...input, commandId, issuedAt } }),
          );
          if (AsyncResult.isFailure(result)) return yield* Effect.failCause(result.cause);
        }),
      }),
      permissionAtom: markUnread.permissionAtom,
    },
  };
}

export function shouldImportLegacyReadMarkers(
  capabilities: ExecutionEnvironmentCapabilities | undefined,
): boolean {
  return capabilities !== undefined && capabilities.j5PersonalThreadReads !== true;
}

// Null denotes imported history until upstream seeds a watermark on the first fresh dispatch.
// Once seeded, a person with no visit must see completions as unread regardless of legacy visits.
const NEVER_VISITED = DateTime.makeUnsafe(0);
export function personalThreadReadMarker(
  markers: PersonalReadMarkers | undefined,
  threadId: ThreadId,
  shared: DateTime.Utc | null,
): DateTime.Utc | null {
  return markers === undefined
    ? shared
    : (markers.get(threadId) ?? (shared === null ? null : NEVER_VISITED));
}
