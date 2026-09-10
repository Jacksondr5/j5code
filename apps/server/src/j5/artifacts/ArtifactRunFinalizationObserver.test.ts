import { assert, it, vi } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as RunFinalization from "../../orchestration-v2/RunFinalizationService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { layer } from "./ArtifactRunFinalizationObserver.ts";
import { ArtifactWorkspace } from "./ArtifactWorkspace.ts";

it.effect("exports a completed plan into shared project application storage", () => {
  const projectId = ProjectId.make("project:shared-artifacts");
  const threadId = ThreadId.make("thread:isolated-worktree");
  const runId = RunId.make("run:shared-artifacts");
  const refresh = vi.fn(() => Effect.void);
  const exportPlan = vi.fn(() => Effect.void);
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ workspaceRoot: "/project-workspace" } as never)),
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
      projectId,
      threadId,
      runId,
      planMarkdown: "# Shared plan",
    });

    assert.deepStrictEqual(refresh.mock.calls, [
      [{ cwd: "/thread-worktree", projectId, threadId, runId, planMarkdown: "# Shared plan" }],
    ]);
    assert.deepStrictEqual(exportPlan.mock.calls, [[{ projectId, markdown: "# Shared plan" }]]);
  }).pipe(Effect.provide(testLayer));
});
