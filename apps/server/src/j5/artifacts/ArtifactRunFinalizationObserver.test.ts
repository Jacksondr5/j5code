import { assert, it, vi } from "@effect/vitest";
import {
  EventId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as RunFinalization from "../../orchestration-v2/RunFinalizationService.ts";
import { layer } from "./ArtifactRunFinalizationObserver.ts";
import { ArtifactWorkspace } from "./ArtifactWorkspace.ts";

it.effect("exports a completed plan into shared project application storage", () => {
  const projectId = ProjectId.make("project:shared-artifacts");
  const threadId = ThreadId.make("thread:isolated-worktree");
  const runId = RunId.make("run:shared-artifacts");
  const refresh = vi.fn(() => Effect.void);
  const exportPlan = vi.fn(() => Effect.void);
  const projection = {
    thread: { projectId },
    plans: [
      {
        id: "plan:aaa-revised",
        kind: "proposed_plan",
        runId,
        status: "active",
        markdown: "# Final revised plan",
      },
      {
        id: "plan:zzz-old",
        kind: "proposed_plan",
        runId,
        status: "superseded",
        markdown: "# Old draft",
      },
    ],
    turnItems: [
      { id: "item:old", type: "proposed_plan", runId, planId: "plan:zzz-old" },
      { id: "item:revised", type: "proposed_plan", runId, planId: "plan:aaa-revised" },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh,
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(ArtifactWorkspace)({ exportPlan }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({
      cwd: "/thread-worktree",
      threadId,
      runId,
    });

    assert.deepStrictEqual(refresh.mock.calls, [[{ cwd: "/thread-worktree", threadId, runId }]]);
    assert.deepStrictEqual(exportPlan.mock.calls, [
      [{ projectId, markdown: "# Final revised plan" }],
    ]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("exports the finished run's plan from the store, not a later run's", () => {
  const projectId = ProjectId.make("project:plan-per-run");
  const threadId = ThreadId.make("thread:plan-per-run");
  const finished = RunId.make("run:plan-finished");
  const later = RunId.make("run:plan-later");
  const instanceId = ProviderInstanceId.make("codex");
  const exportPlan = vi.fn(() => Effect.void);
  const store = ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
  const testLayer = Layer.mergeAll(
    store,
    layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          store,
          Layer.succeed(RunFinalization.RunFinalizationObserver, {
            refresh: () => Effect.void,
            refreshAfterTurn: () => Effect.void,
          }),
          Layer.mock(ArtifactWorkspace)({ exportPlan }),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:plan-per-run:thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        id: threadId,
        projectId,
        title: "Plans",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "test" },
        runtimeMode: "full-access",
        interactionMode: "plan",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    // The later run's plan item is newer, and a non-plan item sits in the finished run.
    for (const [ordinal, runId, type] of [
      [1, finished, "proposed_plan"],
      [2, finished, "reasoning"],
      [3, later, "proposed_plan"],
    ] as const) {
      const planId = PlanId.make(`plan:${runId}`);
      if (type === "proposed_plan")
        yield* projections.apply({
          id: EventId.make(`event:plan:${runId}`),
          type: "plan.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: planId,
            threadId,
            runId,
            nodeId: NodeId.make(`node:${runId}`),
            kind: "proposed_plan",
            status: "active",
            markdown: `# Plan for ${runId}`,
          },
        });
      const base = {
        id: TurnItemId.make(`item:${ordinal}`),
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
      yield* projections.apply({
        id: EventId.make(`event:item:${ordinal}`),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: now,
        payload:
          type === "proposed_plan"
            ? { ...base, type, planId, markdown: `# Plan for ${runId}`, streaming: false }
            : { ...base, type, text: "Thinking about the plan.", streaming: false },
      });
    }

    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({ cwd: "/thread-worktree", threadId, runId: finished });

    assert.deepStrictEqual(exportPlan.mock.calls, [
      [{ projectId, markdown: `# Plan for ${finished}` }],
    ]);
  }).pipe(Effect.provide(testLayer));
});
