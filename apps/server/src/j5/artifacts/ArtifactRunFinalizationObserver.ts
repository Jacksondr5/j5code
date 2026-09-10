import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as RunFinalization from "../../orchestration-v2/RunFinalizationService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { ArtifactWorkspace } from "./ArtifactWorkspace.ts";

/** Preserves upstream refresh behavior and projects a settled structured plan onto disk. */
export const layer = Layer.effect(
  RunFinalization.RunFinalizationObserver,
  Effect.gen(function* () {
    const artifacts = yield* ArtifactWorkspace;
    const projects = yield* ProjectService.ProjectService;
    const upstream = yield* RunFinalization.RunFinalizationObserver;
    return RunFinalization.RunFinalizationObserver.of({
      refreshAfterTurn: upstream.refreshAfterTurn,
      refresh: (input) => {
        const planMarkdown = input.planMarkdown;
        return upstream.refresh(input).pipe(
          Effect.andThen(
            planMarkdown === null
              ? Effect.void
              : Effect.gen(function* () {
                  const project = yield* projects.getById(input.projectId);
                  if (Option.isNone(project)) {
                    return yield* Effect.logWarning(
                      "Completed plan has no project for artifact export",
                      { projectId: input.projectId, threadId: input.threadId, runId: input.runId },
                    );
                  }
                  yield* artifacts.exportPlan({
                    projectId: input.projectId,
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
