import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeProviderRegistryMock } from "../../provider/testUtils/providerRegistryMock.ts";
import { refreshSkillProviders, refreshSkillsOnConnection } from "./skillProviderRefresh.ts";

it.effect("refreshes only selected instances including pending workspace discovery", () =>
  Effect.gen(function* () {
    const snapshot = (id: string): ServerProvider => ({
      instanceId: ProviderInstanceId.make(id),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-09-24T00:00:00Z",
      version: null,
      models: [],
      skills: [],
      slashCommands: [],
    });
    const selected = {
      ...snapshot("selected"),
      workspaceSnapshots: [
        { cwd: "/cached", checkedAt: "2026-09-24T00:00:00Z", skills: [], slashCommands: [] },
      ],
    };
    const calls: string[] = [];
    const registry = {
      ...makeProviderRegistryMock([selected, snapshot("unrelated")]),
      getPendingWorkspaceCwds: () => Effect.succeed(["/pending"]),
      refreshInstance: (id: ProviderInstanceId) =>
        Effect.sync(() => {
          calls.push(id);
          return [];
        }),
      refreshWorkspaceSnapshot: (input: {
        instanceId: ProviderInstanceId;
        cwd: string;
        force?: boolean;
      }) =>
        Effect.sync(() => {
          assert.isTrue(input.force);
          calls.push(`${input.instanceId}:${input.cwd}`);
          return [];
        }),
    };
    yield* refreshSkillProviders(registry, [selected.instanceId], ["/pending", "/selected"]);
    assert.deepStrictEqual(calls, [
      "selected",
      "selected:/pending",
      "selected:/cached",
      "selected:/selected",
    ]);
  }),
);

it.effect("connection cancellation releases both a waiting client and the probe owner", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let calls = 0;
    const registry = {
      ...makeProviderRegistryMock(),
      refresh: (): Effect.Effect<ReadonlyArray<ServerProvider>> =>
        Effect.gen(function* () {
          calls++;
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }),
    };
    const owner = yield* refreshSkillsOnConnection(registry).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const waiter = yield* refreshSkillsOnConnection(registry).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(waiter);
    assert.equal(calls, 1);
    yield* Fiber.interrupt(owner);
    registry.refresh = () =>
      Effect.sync(() => {
        calls++;
        return [];
      });
    yield* refreshSkillsOnConnection(registry);
    assert.equal(calls, 2);
  }),
);
