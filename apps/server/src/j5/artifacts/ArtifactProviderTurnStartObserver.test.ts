import { assert, describe, it, vi } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderTurnStart from "../../orchestration-v2/ProviderTurnStartService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { layer } from "./ArtifactProviderTurnStartObserver.ts";
import { ArtifactWorkspace, ArtifactWorkspaceError } from "./ArtifactWorkspace.ts";

const input = {
  projectId: ProjectId.make("project:shared-artifacts"),
  threadId: ThreadId.make("thread:artifact-preparation"),
  runId: RunId.make("run:artifact-preparation"),
};

const projectLayer = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeed(Option.some({ workspaceRoot: "/project-workspace" } as never)),
});

describe("ArtifactProviderTurnStartObserver", () => {
  it.effect("prepares the shared project workspace before a provider turn", () => {
    const prepare = vi.fn(() => Effect.void);
    const testLayer = layer.pipe(
      Layer.provide(Layer.mergeAll(projectLayer, Layer.mock(ArtifactWorkspace)({ prepare }))),
    );

    return Effect.gen(function* () {
      const observer = yield* ProviderTurnStart.ProviderTurnStartObserver;
      yield* observer.prepare(input);

      assert.deepStrictEqual(prepare.mock.calls, [["/project-workspace"]]);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("does not prevent a provider turn when preparation fails", () => {
    const testLayer = layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          projectLayer,
          Layer.mock(ArtifactWorkspace)({
            prepare: () =>
              Effect.fail(
                new ArtifactWorkspaceError({
                  operation: "prepare-artifacts",
                  detail: "simulated failure",
                }),
              ),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const observer = yield* ProviderTurnStart.ProviderTurnStartObserver;
      yield* observer.prepare(input);
    }).pipe(Effect.provide(testLayer));
  });
});
