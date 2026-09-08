import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ThreadLaunchService } from "../../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { findActionRun, makeAgentAdapter } from "./AgentAdapter.ts";
import type { Action, Run } from "@j5/workflow-contracts";

it("tracks its initial message's exact run even when a newer run exists", () => {
  const runs = [
    { id: "owned", userMessageId: "action:message", status: "completed" },
    { id: "newer", userMessageId: "user-message", status: "running" },
  ];
  assert.equal(findActionRun(runs, "action")?.id, "owned");
  assert.isUndefined(findActionRun(runs, "other"));
});

it.effect(
  "blocks unavailable persona authority before launch and cancels an unlaunched action safely",
  () => {
    let launches = 0;
    const action: Action = {
      id: "action",
      runId: "run",
      phase: "agent",
      revision: 1,
      task: "agent",
      attempt: 1,
      kind: "agent",
      adapter: "persona",
      status: "pending",
      deadline: 1800000,
      result: null,
      input: {
        personaId: "publisher",
        prompt: "Test unsupported authority",
        worktree: "/test",
        branch: "test",
      },
    };
    const run: Run = {
      id: "run",
      definitionId: "test",
      definitionVersion: 1,
      definitionHash: "test",
      squadronId: "s",
      projectId: "p",
      repository: "/test",
      baseCommit: "base",
      inputs: {},
      execution: {},
      phase: "agent",
      revision: 1,
      status: "running",
      cause: null,
      recovery: null,
      gate: null,
      actions: [action],
      artifacts: [],
      approvals: [],
      visits: { agent: 1 },
    };
    return Effect.gen(function* () {
      const adapter = yield* makeAgentAdapter;
      const result = yield* adapter.reconcile(action, run, () => Effect.void);
      assert.equal(result.status, "blocked");
      yield* adapter.interrupt(action);
      assert.equal(launches, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ThreadManagementService)({}),
          Layer.mock(CommandReceiptStoreV2)({
            getByCommandId: () => Effect.succeed(Option.none()),
          }),
          Layer.mock(ThreadLaunchService)({
            launch: () => {
              launches++;
              return Effect.die("Unexpected launch");
            },
          }),
        ),
      ),
    );
  },
);
