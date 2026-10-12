import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  J5_SHARING_WS_METHODS,
  type SharingConnectionKind,
  type SharingThreadLevel,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { isJ5UnsupportedError } from "./http.ts";
import { createSharingEnvironmentAtoms, sharingAllowsOperate } from "./sharing.ts";
import { createJ5EnvironmentAtoms } from "./state.ts";

describe("sharingAllowsOperate", () => {
  it("holds a member's connection to nothing", () => {
    expect(sharingAllowsOperate({ connection: "member", level: null })).toBe(true);
  });

  it("withholds nothing while the server has not said which kind the connection is", () => {
    // A member's composer must not flicker to read-only while the answer is on its way.
    expect(sharingAllowsOperate({ connection: null, level: null })).toBe(true);
  });

  it("keeps a guest read-only on a thread with no grant, and until its level arrives", () => {
    expect(sharingAllowsOperate({ connection: "guest", level: "none" })).toBe(false);
    expect(sharingAllowsOperate({ connection: "guest", level: null })).toBe(false);
  });
});

const MEMBER_SERVER = EnvironmentId.make("own-server");
const SHARED_SERVER = EnvironmentId.make("shared-server");
const VIEWED = ThreadId.make("thread:viewed");
const JOINED = ThreadId.make("thread:joined");

/** Two connected environments: one this person's own, one they are a guest on. */
const environments = Effect.gen(function* () {
  const viewedLevel = yield* SubscriptionRef.make<SharingThreadLevel>("view");
  const asked: Array<string> = [];
  const httpCalls: Array<string> = [];
  const supervisor = Effect.fn(function* (
    environmentId: EnvironmentId,
    kind: SharingConnectionKind,
  ) {
    const target = new BearerConnectionTarget({
      environmentId,
      label: environmentId,
      connectionId: environmentId,
    });
    const prepared: PreparedConnection = {
      environmentId,
      label: environmentId,
      httpBaseUrl: `https://${environmentId}.test`,
      socketUrl: `wss://${environmentId}.test/ws`,
      target,
      httpAuthorization: { _tag: "Bearer", token: environmentId },
    };
    return EnvironmentSupervisor.of({
      target,
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "connected",
        generation: 1,
      }),
      prepared: yield* SubscriptionRef.make(Option.some(prepared)),
      session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(
        Option.some({
          client: {
            [J5_SHARING_WS_METHODS.getConnectionAccess]: () => {
              asked.push(`${environmentId}:connection`);
              return Effect.succeed({ kind });
            },
            [J5_SHARING_WS_METHODS.subscribeThreadAccess]: (input: { threadId: ThreadId }) => {
              asked.push(`${environmentId}:${input.threadId}`);
              return input.threadId === VIEWED
                ? SubscriptionRef.changes(viewedLevel).pipe(
                    Stream.map((level) => ({ kind, level })),
                  )
                : Stream.make({ kind, level: "collaborate" as const }).pipe(
                    Stream.concat(Stream.never),
                  );
            },
          },
        } as unknown as RpcSession),
      ),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
  });
  const supervisors = new Map([
    [MEMBER_SERVER, yield* supervisor(MEMBER_SERVER, "member")],
    [SHARED_SERVER, yield* supervisor(SHARED_SERVER, "guest")],
  ]);
  const layer = Layer.merge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        httpCalls.push(request.url);
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ projects: [] })));
      }),
    ),
    Layer.mock(EnvironmentRegistry)({
      entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
        new Map(),
      ),
      networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
      run: (id, effect) =>
        effect.pipe(Effect.provideService(EnvironmentSupervisor, supervisors.get(id)!)),
      followStream: (id, stream) =>
        stream.pipe(Stream.provideService(EnvironmentSupervisor, supervisors.get(id)!)),
    }),
  );
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make()),
    (registry) => Effect.sync(() => registry.dispose()),
  );
  return { layer, registry, viewedLevel, asked, httpCalls };
});

/** Waits for the atom to hold `expected`; a value that never arrives fails the test by timeout. */
const settlesAt = <A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>, expected: A) =>
  AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter((value) => value === expected),
    Stream.runHead,
    Effect.map(Option.isSome),
  );

describe("a guest's connection", () => {
  it.effect("reads one thread and writes to another on the same server", () =>
    Effect.gen(function* () {
      const { layer, registry, viewedLevel, asked } = yield* environments;
      const sharing = createSharingEnvironmentAtoms(Atom.runtime(layer));
      const viewed = sharing.threadOperable(SHARED_SERVER, VIEWED);
      const joined = sharing.threadOperable(SHARED_SERVER, JOINED);
      const draft = sharing.threadOperable(SHARED_SERVER, null);
      const own = sharing.threadOperable(MEMBER_SERVER, VIEWED);
      for (const atom of [viewed, joined, draft, own]) yield* AtomRegistry.mount(registry, atom);

      expect(yield* settlesAt(registry, sharing.connectionKind(SHARED_SERVER), "guest")).toBe(true);
      expect(yield* settlesAt(registry, joined, true)).toBe(true);
      expect(registry.get(viewed)).toBe(false);
      expect(registry.get(draft)).toBe(false);

      // The member raises the first thread to Collaborate while the guest has it open.
      yield* SubscriptionRef.set(viewedLevel, "collaborate");
      expect(yield* settlesAt(registry, viewed, true)).toBe(true);
      yield* SubscriptionRef.set(viewedLevel, "none");
      expect(yield* settlesAt(registry, viewed, false)).toBe(true);

      // On the person's own server nothing is withheld, and no thread is asked about.
      expect(yield* settlesAt(registry, sharing.connectionKind(MEMBER_SERVER), "member")).toBe(
        true,
      );
      expect(registry.get(own)).toBe(true);
      expect(asked.filter((entry) => entry.startsWith(MEMBER_SERVER))).toEqual([
        `${MEMBER_SERVER}:connection`,
      ]);
    }),
  );

  it.effect("sends none of J5's reads to the server it is a guest on", () =>
    Effect.gen(function* () {
      const { layer, registry, httpCalls } = yield* environments;
      const atoms = createJ5EnvironmentAtoms(Atom.runtime(layer));
      const own = atoms.fleet({ environmentId: MEMBER_SERVER, input: {} });
      const shared = atoms.fleet({ environmentId: SHARED_SERVER, input: {} });
      yield* AtomRegistry.mount(registry, own);
      yield* AtomRegistry.mount(registry, shared);
      yield* AtomRegistry.getResult(registry, own);
      const refused = yield* AtomRegistry.getResult(registry, shared).pipe(Effect.flip);
      // The same answer as a server without the feature, which the read sources never poll.
      expect(isJ5UnsupportedError(refused)).toBe(true);
      expect(AsyncResult.isFailure(registry.get(shared))).toBe(true);
      expect(httpCalls).toHaveLength(1);
      expect(httpCalls[0]).toContain(MEMBER_SERVER);
    }),
  );
});
