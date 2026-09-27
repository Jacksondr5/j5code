import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { makeProviderRegistryMock } from "../../provider/testUtils/providerRegistryMock.ts";
import { refreshSkillProviders } from "./skillProviderRefresh.ts";

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
