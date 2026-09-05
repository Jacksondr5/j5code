import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as RunFinalization from "../../orchestration-v2/RunFinalizationService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import { ArtifactWorkspace } from "./ArtifactWorkspace.ts";

/** Preserves upstream refresh behavior and projects a settled structured plan onto disk. */
export const layer = Layer.effect(
  RunFinalization.RunFinalizationObserver,
  Effect.gen(function* () {
    const artifacts = yield* ArtifactWorkspace;
    const projects = yield* ProjectService.ProjectService;
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    return RunFinalization.RunFinalizationObserver.of({
      refresh: (input) => {
        const planMarkdown = input.planMarkdown;
        return Effect.all(
          [workspaceEntries.refresh(input.cwd), vcsStatus.refreshStatus(input.cwd)],
          {
            discard: true,
            concurrency: "unbounded",
          },
        ).pipe(
          Effect.mapError(
            (cause) => new RunFinalization.RunFinalizationRefreshError({ cwd: input.cwd, cause }),
          ),
          Effect.andThen(
            planMarkdown === null
              ? Effect.void
              : Effect.gen(function* () {
                  const project = yield* projects.getById(input.projectId);
                  if (Option.isNone(project)) {
                    return yield* Effect.logWarning(
                      "Completed plan has no project workspace for artifact export",
                      { projectId: input.projectId, threadId: input.threadId, runId: input.runId },
                    );
                  }
                  yield* artifacts.exportPlan({
                    cwd: project.value.workspaceRoot,
                    markdown: planMarkdown,
                  });
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Completed plan could not be exported as an artifact", {
                      cause,
                      projectId: input.projectId,
                      threadId: input.threadId,
                      runId: input.runId,
                      cwd: input.cwd,
                    }),
                  ),
                ),
          ),
        );
      },
    });
  }),
);
