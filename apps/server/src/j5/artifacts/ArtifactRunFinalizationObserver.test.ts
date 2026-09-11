import { assert, it, vi } from "@effect/vitest";
import {
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
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
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh,
          refreshAfterTurn: Effect.void,
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
