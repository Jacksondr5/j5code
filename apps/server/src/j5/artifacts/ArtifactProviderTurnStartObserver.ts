import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderTurnStart from "../../orchestration-v2/ProviderTurnStartService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { ArtifactWorkspace } from "./ArtifactWorkspace.ts";

/** Prepares the shared artifact workspace before the provider can create planning files. */
export const layer = Layer.effect(
  ProviderTurnStart.ProviderTurnStartObserver,
  Effect.gen(function* () {
    const artifacts = yield* ArtifactWorkspace;
    const projects = yield* ProjectService.ProjectService;

    return ProviderTurnStart.ProviderTurnStartObserver.of({
      prepare: (input) =>
        Effect.gen(function* () {
          const project = yield* projects.getById(input.projectId);
          if (Option.isNone(project)) {
            return yield* Effect.logWarning(
              "Provider turn has no project workspace for artifact preparation",
              input,
            );
          }
          yield* artifacts.prepare(project.value.workspaceRoot);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Artifact workspace could not be prepared before provider turn", {
              cause,
              ...input,
            }),
          ),
        ),
    });
  }),
);
