import { assert, it, vi } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as RunFinalization from "../../orchestration-v2/RunFinalizationService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import { layer } from "./ArtifactRunFinalizationObserver.ts";
import { ArtifactWorkspace } from "./ArtifactWorkspace.ts";

it.effect("exports a completed plan into the shared project workspace", () => {
  const projectId = ProjectId.make("project:shared-artifacts");
  const threadId = ThreadId.make("thread:isolated-worktree");
  const runId = RunId.make("run:shared-artifacts");
  const refreshEntries = vi.fn(() => Effect.void);
  const refreshStatus = vi.fn(() => Effect.succeed({} as never));
  const exportPlan = vi.fn(() => Effect.void);
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ workspaceRoot: "/project-workspace" } as never)),
        }),
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: refreshEntries }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({ refreshStatus }),
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

    assert.deepStrictEqual(refreshEntries.mock.calls, [["/thread-worktree"]]);
    assert.deepStrictEqual(refreshStatus.mock.calls, [["/thread-worktree"]]);
    assert.deepStrictEqual(exportPlan.mock.calls, [
      [{ cwd: "/project-workspace", markdown: "# Shared plan" }],
    ]);
  }).pipe(Effect.provide(testLayer));
});
