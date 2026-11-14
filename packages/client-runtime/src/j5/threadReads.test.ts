import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentId,
  ThreadId,
  ORCHESTRATION_V2_WS_METHODS,
  type AuthSessionState,
} from "@t3tools/contracts";
import {
  J5_ACCESS_WS_METHODS,
  J5_THREAD_READ_WS_METHODS,
  type PersonalThreadReadChange,
} from "@t3tools/contracts/j5";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { NetworkStatus } from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createPersonalThreadReadAtoms,
  createPersonalThreadReadCommands,
  shouldImportLegacyReadMarkers,
} from "./threadReads.ts";

vi.mock("../state/session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const environmentId = EnvironmentId.make("server");
const threadId = ThreadId.make("thread");
const at = DateTime.makeUnsafe("2026-10-31T12:00:00.000Z");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationReadScope] : [],
  permissions: allowed ? [AuthOrchestrationReadScope] : [],
});

const setup = Effect.fn("test.personalReads")(function* (personal: boolean) {
  const person = yield* SubscriptionRef.make("alice");
  const calls: Array<{ tag: string; input: unknown }> = [];
  const changes = yield* SubscriptionRef.make<PersonalThreadReadChange>({
    kind: "snapshot",
    markers: [{ threadId, lastVisitedAt: at }],
  });
  const supervisor = EnvironmentSupervisor.of({
    target: { environmentId },
    session: yield* SubscriptionRef.make(
      Option.some({
        initialConfig: Effect.succeed({
          environment: { capabilities: { j5PersonalThreadReads: personal } },
        }),
        client: {
          [J5_ACCESS_WS_METHODS.getConnectionAccess]: () =>
            SubscriptionRef.get(person).pipe(
              Effect.map((personId) => ({ kind: "person", personId })),
            ),
          [J5_THREAD_READ_WS_METHODS.visit]: (input: unknown) =>
            Effect.sync(() => {
              calls.push({ tag: "visit", input });
              return { threadId, lastVisitedAt: at };
            }),
          [J5_THREAD_READ_WS_METHODS.markUnread]: (input: unknown) =>
            Effect.sync(() => {
              calls.push({ tag: "unread", input });
              return { threadId, lastVisitedAt: at };
            }),
          [J5_THREAD_READ_WS_METHODS.subscribe]: () => SubscriptionRef.changes(changes),
          [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (input: unknown) =>
            Effect.sync(() => {
              calls.push({ tag: "legacy", input });
              return { sequence: 1 };
            }),
        },
      } as unknown as RpcSession),
    ),
  } as EnvironmentSupervisor["Service"]);
  const layer = Layer.mergeAll(
    Layer.succeed(Clock.Clock, yield* Clock.Clock),
    Layer.mock(EnvironmentRegistry)({
      entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
        new Map(),
      ),
      networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
      run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
      followStream: (_id, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor, supervisor),
    }),
    Layer.succeed(
      SecureRandom.SecureRandom,
      SecureRandom.make((size) => new Uint8Array(size)),
    ),
  );
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make()),
    (registry) => Effect.sync(() => registry.dispose()),
  );
  registry.set(sessions(environmentId), AsyncResult.success(grant(true)));
  return {
    runtime: Atom.runtime(layer),
    registry,
    calls,
    changes,
    person,
    session: supervisor.session,
  };
});

it.effect(
  "uses personal read RPCs for a viewer and checks their current permission before writing",
  () =>
    Effect.gen(function* () {
      const { runtime, registry, calls } = yield* setup(true);
      const commands = createPersonalThreadReadCommands(runtime);
      const input = {
        threadId,
        visitedAt: DateTime.formatIso(at),
      };
      expect(
        (yield* Effect.promise(() => commands.visit.run(registry, { environmentId, input })))._tag,
      ).toBe("Success");
      expect(
        (yield* Effect.promise(() =>
          commands.markUnread.run(registry, {
            environmentId,
            input: {
              threadId,
              issuedAt: "1970-01-01T00:00:00.000Z",
              commandId: CommandId.make("unread"),
            },
          }),
        ))._tag,
      ).toBe("Success");
      expect(calls.map((call) => call.tag)).toEqual(["visit", "unread"]);
      expect(calls[0]?.input).toMatchObject({
        ...input,
        commandId: expect.any(String),
        issuedAt: DateTime.formatIso(yield* DateTime.now),
      });
      registry.set(sessions(environmentId), AsyncResult.success(grant(false)));
      expect(registry.get(commands.visit.permissionAtom(environmentId))).toBe(false);
      expect(
        (yield* Effect.promise(() => commands.visit.run(registry, { environmentId, input })))._tag,
      ).toBe("Failure");
      expect(calls).toHaveLength(2);
    }).pipe(Effect.scoped),
);

it.effect("keeps upstream visit and mark-unread commands on servers without personal reads", () =>
  Effect.gen(function* () {
    const { runtime, registry, calls } = yield* setup(false);
    const commands = createPersonalThreadReadCommands(runtime);
    yield* Effect.promise(() =>
      commands.visit.run(registry, {
        environmentId,
        input: {
          threadId,
          issuedAt: "1970-01-01T00:00:00.000Z",
          commandId: CommandId.make("read"),
          visitedAt: DateTime.formatIso(at),
        },
      }),
    );
    yield* Effect.promise(() =>
      commands.markUnread.run(registry, {
        environmentId,
        input: {
          threadId,
          issuedAt: "1970-01-01T00:00:00.000Z",
          commandId: CommandId.make("unread"),
        },
      }),
    );
    expect(calls).toEqual([
      {
        tag: "legacy",
        input: {
          type: "thread.visit",
          threadId,
          commandId: "read",
          visitedAt: DateTime.formatIso(at),
        },
      },
      { tag: "legacy", input: { type: "thread.mark-unread", threadId, commandId: "unread" } },
    ]);
    const markers = createPersonalThreadReadAtoms(runtime).markersAtom(environmentId);
    expect(
      yield* AtomRegistry.toStream(registry, markers).pipe(
        Stream.filter((value) => value === undefined),
        Stream.runHead,
      ),
    ).toEqual(Option.some(undefined));
  }).pipe(Effect.scoped),
);

it.effect("waits for the first connection and restores personal markers after reconnecting", () =>
  Effect.gen(function* () {
    const { runtime, registry, session } = yield* setup(true);
    const connected = yield* SubscriptionRef.get(session);
    yield* SubscriptionRef.set(session, Option.none());
    const atom = createPersonalThreadReadAtoms(runtime).markersAtom(environmentId);
    yield* AtomRegistry.mount(registry, atom);
    expect(yield* AtomRegistry.toStream(registry, atom).pipe(Stream.runHead)).toEqual(
      Option.some(undefined),
    );
    yield* SubscriptionRef.set(session, connected);
    yield* AtomRegistry.toStream(registry, atom).pipe(
      Stream.filter((markers) => markers?.get(threadId) === at),
      Stream.runHead,
    );
    yield* SubscriptionRef.set(session, Option.none());
    yield* AtomRegistry.toStream(registry, atom).pipe(
      Stream.filter((markers) => markers?.get(threadId) === at),
      Stream.runHead,
    );
    yield* SubscriptionRef.set(session, connected);
    yield* AtomRegistry.toStream(registry, atom).pipe(
      Stream.filter((markers) => markers?.get(threadId) === at),
      Stream.runHead,
    );
  }).pipe(Effect.scoped),
);

it.effect("applies snapshot replacements and read rewinds from the person's stream", () =>
  Effect.gen(function* () {
    const { runtime, registry, changes } = yield* setup(true);
    const atom = createPersonalThreadReadAtoms(runtime).markersAtom(environmentId);
    yield* AtomRegistry.mount(registry, atom);
    yield* AtomRegistry.toStream(registry, atom).pipe(
      Stream.filter((markers) => markers?.get(threadId) === at),
      Stream.runHead,
    );
    const earlier = DateTime.subtract(at, { milliseconds: 1 });
    yield* SubscriptionRef.set(changes, {
      kind: "changed",
      marker: { threadId, lastVisitedAt: earlier },
    });
    yield* AtomRegistry.toStream(registry, atom).pipe(
      Stream.filter((markers) => markers?.get(threadId) === earlier),
      Stream.runHead,
    );
    yield* SubscriptionRef.set(changes, { kind: "snapshot", markers: [] });
    yield* AtomRegistry.toStream(registry, atom).pipe(
      Stream.filter((markers) => markers?.size === 0),
      Stream.runHead,
    );
    expect(registry.get(atom)?.size).toBe(0);
  }).pipe(Effect.scoped),
);

it("never imports an unowned browser watermark into personal read state", () => {
  expect(shouldImportLegacyReadMarkers(undefined)).toBe(false);
  expect(
    shouldImportLegacyReadMarkers({ repositoryIdentity: false, j5PersonalThreadReads: true }),
  ).toBe(false);
  expect(shouldImportLegacyReadMarkers({ repositoryIdentity: false })).toBe(true);
});

it.effect("keeps a retry's id and issuance time even after its receipt could expire", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("25 hours");
    const { runtime, registry, calls } = yield* setup(true);
    const commands = createPersonalThreadReadCommands(runtime);
    const input = {
      threadId,
      commandId: CommandId.make("retry-unread"),
      issuedAt: "1970-01-01T00:00:00.000Z",
    };
    yield* Effect.promise(() => commands.markUnread.run(registry, { environmentId, input }));
    yield* Effect.promise(() => commands.markUnread.run(registry, { environmentId, input }));
    expect(calls.map((call) => call.input)).toEqual([input, input]);
  }).pipe(Effect.scoped),
);

it.effect("clears the previous person's cache before a new person's snapshot", () =>
  Effect.gen(function* () {
    const { runtime, registry, session, person } = yield* setup(true);
    const atom = createPersonalThreadReadAtoms(runtime).markersAtom(environmentId);
    yield* AtomRegistry.mount(registry, atom);
    yield* AtomRegistry.toStream(registry, atom).pipe(
      Stream.filter((markers) => markers?.get(threadId) === at),
      Stream.runHead,
    );
    const previous = Option.getOrThrow(yield* SubscriptionRef.get(session));
    yield* SubscriptionRef.set(session, Option.none());
    yield* SubscriptionRef.set(person, "bob");
    yield* SubscriptionRef.set(
      session,
      Option.some({
        ...previous,
        client: {
          ...previous.client,
          [J5_THREAD_READ_WS_METHODS.subscribe]: (() =>
            Stream.never) as RpcSession["client"][typeof J5_THREAD_READ_WS_METHODS.subscribe],
        },
      }),
    );
    expect(
      yield* AtomRegistry.toStream(registry, atom).pipe(
        Stream.filter((markers) => markers === undefined),
        Stream.runHead,
      ),
    ).toEqual(Option.some(undefined));
  }).pipe(Effect.scoped),
);
