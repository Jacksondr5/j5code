import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectService from "../../project/ProjectService.ts";
import { AgentHandoffArtifactDelete } from "../agents/agentHandoffArtifactDelete.ts";
import { ArtifactWorkspace, type ArtifactWorkspaceError } from "./ArtifactWorkspace.ts";

export class ArtifactProjectUnavailableError extends Schema.TaggedError<ArtifactProjectUnavailableError>()(
  "ArtifactProjectUnavailableError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} is not available.`;
  }
}

/**
 * The person's permanent delete of one artifact. A saved-agent handoff that pointed at the file is
 * marked missing afterwards; that step is best-effort, because the file is already gone and
 * cannot be put back.
 */
export class ArtifactDeletion extends Context.Service<
  ArtifactDeletion,
  {
    readonly delete: (input: {
      readonly projectId: ProjectId;
      readonly path: string;
    }) => Effect.Effect<
      void,
      | ArtifactProjectUnavailableError
      | ArtifactWorkspaceError
      | ProjectService.ProjectOperationError
    >;
  }
>()("t3/j5/artifacts/ArtifactDeletion") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const artifacts = yield* ArtifactWorkspace;
  const handoffs = yield* AgentHandoffArtifactDelete;

  return ArtifactDeletion.of({
    delete: Effect.fn("j5.artifacts.delete")(function* ({ projectId, path }) {
      if (Option.isNone(yield* projects.getById(projectId))) {
        return yield* new ArtifactProjectUnavailableError({ projectId });
      }
      const deleted = yield* artifacts.delete({ projectId, relativePath: path });
      yield* handoffs.reconcile({ projectId, path: deleted }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Deleted artifact handoff state could not be reconciled", {
            cause,
            projectId,
            path,
          }),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(ArtifactDeletion, make);
