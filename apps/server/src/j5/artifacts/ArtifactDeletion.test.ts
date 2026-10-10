import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../../project/ProjectService.ts";
import { AgentHandoffArtifactDelete } from "../agents/agentHandoffArtifactDelete.ts";
import { ArtifactDeletion, layer } from "./ArtifactDeletion.ts";
import { ArtifactWorkspace, ArtifactWorkspaceError } from "./ArtifactWorkspace.ts";

const projectId = ProjectId.make("project:artifact-deletion");
const goneProjectId = ProjectId.make("project:artifact-deletion-gone");

const deletionWith = (seen: { deleted: Array<string>; reconciled: Array<string> }) =>
  layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            Effect.succeed(id === goneProjectId ? Option.none() : Option.some({ id } as never)),
        }),
        Layer.mock(ArtifactWorkspace)({
          delete: ({ relativePath }) =>
            relativePath === "missing.md"
              ? Effect.fail(
                  new ArtifactWorkspaceError({
                    operation: "delete",
                    detail: "Artifact missing.md does not exist.",
                    reason: "not_found",
                  }),
                )
              : Effect.sync(() => {
                  seen.deleted.push(relativePath);
                  return "plan.md";
                }),
        }),
        Layer.mock(AgentHandoffArtifactDelete)({
          reconcile: ({ path }) =>
            path === "plan.md" && seen.reconciled.length > 0
              ? Effect.die("handoff table unavailable")
              : Effect.sync(() => void seen.reconciled.push(path)),
        }),
      ),
    ),
  );

it.effect("deletes the file, then marks a handoff that pointed at its stored path", () => {
  const seen = { deleted: [] as Array<string>, reconciled: [] as Array<string> };
  return Effect.gen(function* () {
    const deletion = yield* ArtifactDeletion;
    yield* deletion.delete({ projectId, path: "./plan.md" });
    assert.deepStrictEqual(seen.deleted, ["./plan.md"]);
    // The handoff is matched by the path the workspace resolved, not the one the client sent.
    assert.deepStrictEqual(seen.reconciled, ["plan.md"]);
    // The file is already gone, so a failed handoff update does not fail the delete.
    yield* deletion.delete({ projectId, path: "plan.md" });
    assert.deepStrictEqual(seen.deleted, ["./plan.md", "plan.md"]);
  }).pipe(Effect.provide(deletionWith(seen)));
});

it.effect(
  "refuses an unknown project before touching the workspace, and reports a missing file",
  () => {
    const seen = { deleted: [] as Array<string>, reconciled: [] as Array<string> };
    return Effect.gen(function* () {
      const deletion = yield* ArtifactDeletion;
      const gone = yield* deletion
        .delete({ projectId: goneProjectId, path: "plan.md" })
        .pipe(Effect.flip);
      assert.equal(gone._tag, "ArtifactProjectUnavailableError");
      const missing = yield* deletion.delete({ projectId, path: "missing.md" }).pipe(Effect.flip);
      assert.deepInclude(missing, { _tag: "ArtifactWorkspaceError", reason: "not_found" });
      assert.deepStrictEqual(seen, { deleted: [], reconciled: [] });
    }).pipe(Effect.provide(deletionWith(seen)));
  },
);
