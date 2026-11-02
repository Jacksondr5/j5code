import {
  CommandId,
  type EnvironmentId,
  type ThreadId,
  type ExecutionEnvironmentCapabilities,
} from "@t3tools/contracts";
import { J5_THREAD_READ_WS_METHODS, type PersonalThreadReadChange } from "@t3tools/contracts/j5";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
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
          const config = yield* getInitialServerConfig();
          if (config.environment.capabilities.j5PersonalThreadReads !== true)
            return Stream.succeed(undefined);
          return subscribe(J5_THREAD_READ_WS_METHODS.subscribe, {}).pipe(
            Stream.scan(() => EMPTY_MARKERS, applyPersonalReadChange),
          );
        }),
      ),
    idleTtlMs: 0,
  });
  const markersAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(
        AsyncResult.value(get(state({ environmentId, input: undefined }))),
        () => EMPTY_MARKERS,
      ),
    ),
  );
  return { markersAtom };
}

export function createPersonalThreadReadCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
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
          input: VisitThreadInput,
          registry: AtomRegistry.AtomRegistry,
          environmentId: EnvironmentId,
        ) {
          const config = yield* getInitialServerConfig();
          if (config.environment.capabilities.j5PersonalThreadReads !== true)
            return yield* visitThread(input).pipe(Effect.asVoid);
          const commandId =
            input.commandId ??
            CommandId.make(yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.orDie));
          const result = yield* Effect.promise(() =>
            visit.run(registry, { environmentId, input: { ...input, commandId } }),
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
          input: MarkThreadUnreadInput,
          registry: AtomRegistry.AtomRegistry,
          environmentId: EnvironmentId,
        ) {
          const config = yield* getInitialServerConfig();
          if (config.environment.capabilities.j5PersonalThreadReads !== true)
            return yield* markThreadUnread(input).pipe(Effect.asVoid);
          const commandId =
            input.commandId ??
            CommandId.make(yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.orDie));
          const result = yield* Effect.promise(() =>
            markUnread.run(registry, { environmentId, input: { ...input, commandId } }),
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
