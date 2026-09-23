import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { J5_PLAYBOOK_WS_METHODS } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
  type NetworkStatus,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { J5HttpError } from "./http.ts";
import { createJ5EnvironmentAtoms, supportedJ5Read } from "./state.ts";

it.effect(
  "uses registry-owned connections, shares reads, and refreshes with new credentials on reconnect",
  () =>
    Effect.gen(function* () {
      const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
      const revisions = new Map<EnvironmentId, SubscriptionRef.SubscriptionRef<number>>();
      for (const id of ["alpha", "bravo"]) {
        const environmentId = EnvironmentId.make(id);
        const revision = yield* SubscriptionRef.make(0);
        revisions.set(environmentId, revision);
        const target = new BearerConnectionTarget({ environmentId, label: id, connectionId: id });
        const prepared: PreparedConnection = {
          environmentId,
          label: id,
          httpBaseUrl: `https://${id}.test`,
          socketUrl: `wss://${id}.test/ws`,
          target,
          httpAuthorization: { _tag: "Bearer", token: `${id}-1` },
        };
        supervisors.set(
          environmentId,
          EnvironmentSupervisor.of({
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
                  [J5_PLAYBOOK_WS_METHODS.subscribeChanges]: () =>
                    SubscriptionRef.changes(revision),
                },
              } as unknown as RpcSession),
            ),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          }),
        );
      }
      const calls: string[] = [];
      const client = HttpClient.make((request) => {
        calls.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/api/j5/playbooks/thread")
              ? request.headers.authorization === "Bearer alpha-1"
                ? Response.json({ error: "not_found", message: "Not found" }, { status: 404 })
                : Response.json({ runs: [] })
              : Response.json({
                  squadrons: [
                    {
                      squadron: {
                        id: "squadron:shared",
                        name: request.headers.authorization,
                        createdAt: "2026-09-08T00:00:00Z",
                      },
                      projectIds: [],
                    },
                  ],
                }),
          ),
        );
      });
      const layer = Layer.merge(
        Layer.succeed(HttpClient.HttpClient, client),
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
      const atoms = createJ5EnvironmentAtoms(Atom.runtime(layer));
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => AtomRegistry.make()),
        (registry) => Effect.sync(() => registry.dispose()),
      );
      const alphaId = EnvironmentId.make("alpha");
      const alpha = atoms.squadrons({ environmentId: alphaId, input: {} });
      const bravo = atoms.squadrons({ environmentId: EnvironmentId.make("bravo"), input: {} });
      yield* AtomRegistry.mount(registry, alpha);
      yield* AtomRegistry.mount(registry, bravo);
      const first = yield* AtomRegistry.getResult(registry, alpha);
      const second = yield* AtomRegistry.getResult(registry, bravo);
      expect(first[0]?.squadron.name).toBe("Bearer alpha-1");
      expect(second[0]?.squadron.name).toBe("Bearer bravo-1");
      yield* AtomRegistry.getResult(
        registry,
        atoms.squadrons({ environmentId: alphaId, input: {} }),
      );
      expect(calls).toHaveLength(2);

      const alphaChanges = atoms.playbookChanges({ environmentId: alphaId, input: {} });
      const bravoChanges = atoms.playbookChanges({
        environmentId: EnvironmentId.make("bravo"),
        input: {},
      });
      expect(atoms.playbookChanges({ environmentId: alphaId, input: {} })).toBe(alphaChanges);
      yield* AtomRegistry.mount(registry, alphaChanges);
      yield* AtomRegistry.mount(registry, bravoChanges);
      expect(yield* AtomRegistry.getResult(registry, alphaChanges)).toBe(0);
      expect(yield* AtomRegistry.getResult(registry, bravoChanges)).toBe(0);
      yield* SubscriptionRef.set(revisions.get(alphaId)!, 1);
      const changed = yield* AtomRegistry.toStream(registry, alphaChanges).pipe(
        Stream.filter((result) => AsyncResult.isSuccess(result) && result.value === 1),
        Stream.runHead,
      );
      expect(Option.isSome(changed)).toBe(true);
      expect(yield* AtomRegistry.getResult(registry, bravoChanges)).toBe(0);

      const threadInput = { threadId: ThreadId.make("thread:playbooks") };
      const alphaThread = atoms.playbooks({ environmentId: alphaId, input: threadInput });
      const bravoThread = atoms.playbooks({
        environmentId: EnvironmentId.make("bravo"),
        input: threadInput,
      });
      yield* AtomRegistry.mount(registry, alphaThread);
      yield* AtomRegistry.mount(registry, bravoThread);
      expect(yield* AtomRegistry.getResult(registry, alphaThread)).toEqual({ supported: false });
      expect(yield* AtomRegistry.getResult(registry, bravoThread)).toEqual({
        supported: true,
        runs: [],
      });

      const supervisor = supervisors.get(alphaId)!;
      const previous = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(previous)) return yield* Effect.die("Missing prepared connection");
      yield* SubscriptionRef.set(
        supervisor.prepared,
        Option.some({ ...previous.value, httpAuthorization: { _tag: "Bearer", token: "alpha-2" } }),
      );
      yield* SubscriptionRef.update(supervisor.state, (state) => ({ ...state, generation: 2 }));
      const refreshed = yield* AtomRegistry.toStream(registry, alpha).pipe(
        Stream.filter(
          (result) =>
            AsyncResult.isSuccess(result) && result.value[0]?.squadron.name === "Bearer alpha-2",
        ),
        Stream.runHead,
      );
      expect(Option.isSome(refreshed)).toBe(true);
      const recoveredThread = yield* AtomRegistry.toStream(registry, alphaThread).pipe(
        Stream.filter((result) => AsyncResult.isSuccess(result) && result.value.supported),
        Stream.runHead,
      );
      expect(Option.isSome(recoveredThread)).toBe(true);
      expect(calls.filter((url) => url.endsWith("/squadrons"))).toHaveLength(3);
      expect(calls.filter((url) => url.endsWith("/playbooks/thread"))).toHaveLength(3);
    }).pipe(Effect.scoped),
);

it.effect("keeps authorization, resource, and transient failures as errors", () =>
  Effect.gen(function* () {
    for (const error of [
      new J5HttpError({ status: 401, detail: "Sign in again" }),
      new J5HttpError({ status: 404, code: "workspace_not_found", detail: "Missing workspace" }),
      new J5HttpError({ status: 503, detail: "Try again" }),
    ]) {
      expect(Exit.isFailure(yield* Effect.exit(supportedJ5Read(Effect.fail(error))))).toBe(true);
    }
  }),
);
