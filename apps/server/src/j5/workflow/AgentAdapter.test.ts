import { testExecution } from "./testFixtures.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  ThreadLaunchService,
  ThreadLaunchError,
  type ThreadLaunchInput,
} from "../../orchestration-v2/ThreadLaunchService.ts";
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

it.effect("blocks legacy workflows before launch and cancels an unlaunched action safely", () => {
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
    resultArtifactId: null,
    input: {
      personaId: "publisher",
      prompt: "Test unsupported authority",
      worktree: "/test",
      branch: "test",
      selectedEvidenceIds: [],
      selectedEvidenceHashes: [],
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
});

it.effect("reuses the exact saved assignment for retries and output corrections", () => {
  const captured: ThreadLaunchInput[] = [];
  const assignment = testExecution.personas.scout;
  const input = {
    personaId: "scout",
    assignmentDigest: assignment.definitionDigest,
    prompt: "Test",
    worktree: "/test",
    branch: "test",
    selectedEvidenceIds: [],
    selectedEvidenceHashes: [],
  };
  const action: Action = {
    id: "action",
    runId: "run",
    phase: "context",
    revision: 1,
    task: "scout",
    attempt: 1,
    kind: "agent",
    adapter: "persona",
    status: "pending",
    deadline: 10000,
    resultArtifactId: null,
    input,
  };
  const run: Run = {
    id: "run",
    definitionId: "test",
    definitionVersion: 3,
    definitionHash: "test",
    squadronId: "s",
    projectId: "p",
    repository: "/test",
    baseCommit: "base",
    inputs: {},
    execution: testExecution,
    phase: "context",
    revision: 1,
    status: "running",
    cause: null,
    recovery: null,
    gate: null,
    actions: [action],
    artifacts: [],
    approvals: [],
    visits: { context: 1 },
  };
  return Effect.gen(function* () {
    const adapter = yield* makeAgentAdapter;
    for (const current of [
      action,
      action,
      {
        ...action,
        id: "correction",
        input: { original: input, correction: "Return valid JSON", output: "bad" },
      },
    ]) {
      yield* adapter.reconcile(current, run, () => Effect.void).pipe(Effect.flip);
    }
    assert.lengthOf(captured, 3);
    for (const launch of captured) {
      assert.deepEqual(launch.preparedPersonaAssignment, assignment);
      assert.deepEqual(launch.modelSelection, assignment.resolvedModelSelection);
      assert.isUndefined(launch.agentPersona);
    }
    assert.include(captured[2]!.initialMessage!.text, "Return valid JSON");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService)({}),
        Layer.mock(CommandReceiptStoreV2)({ getByCommandId: () => Effect.succeed(Option.none()) }),
        Layer.mock(ThreadLaunchService)({
          launch: (launch) => {
            captured.push(launch);
            // Stop at the thread service boundary; its real guards are tested by the launch integration.
            return Effect.fail(
              new ThreadLaunchError({
                operation: "create-thread",
                commandId: launch.commandId,
                projectId: launch.projectId,
                cause: "Captured launch",
              }),
            );
          },
        }),
      ),
    ),
  );
});
