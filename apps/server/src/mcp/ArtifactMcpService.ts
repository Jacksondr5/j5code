import {
  ArtifactMcpFailure,
  type ArtifactContent,
  type ArtifactListResponse,
  type ArtifactWriteInput,
  type ArtifactWriteResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ArtifactWorkspace } from "../j5/artifacts/ArtifactWorkspace.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export class ArtifactMcpService extends Context.Service<
  ArtifactMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
    ) => Effect.Effect<ArtifactListResponse, ArtifactMcpFailure>;
    readonly read: (
      scope: McpInvocationScope,
      path: string,
    ) => Effect.Effect<ArtifactContent, ArtifactMcpFailure>;
    readonly write: (
      scope: McpInvocationScope,
      input: ArtifactWriteInput,
    ) => Effect.Effect<ArtifactWriteResult, ArtifactMcpFailure>;
  }
>()("t3/mcp/ArtifactMcpService") {}

const failure = (code: ArtifactMcpFailure["code"], message: string) =>
  new ArtifactMcpFailure({ code, message });

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const make = Effect.gen(function* () {
  const artifacts = yield* ArtifactWorkspace;
  const threadManagement = yield* ThreadManagementService;

  const projectIdFor = Effect.fn("ArtifactMcpService.projectIdFor")(function* (
    scope: McpInvocationScope,
  ) {
    if (!scope.capabilities.has("artifacts")) {
      return yield* failure(
        "capability_denied",
        "This MCP credential does not grant artifact capabilities.",
      );
    }
    const projection = yield* threadManagement
      .getThreadProjection(scope.threadId)
      .pipe(
        Effect.mapError((error) =>
          error._tag === "OrchestratorProjectionError"
            ? failure("thread_not_found", `Thread '${scope.threadId}' was not found.`)
            : failure(
                "operation_failed",
                `Unable to read thread '${scope.threadId}': ${errorMessage(error)}`,
              ),
        ),
      );
    if (projection.thread.deletedAt !== null) {
      return yield* failure("thread_not_found", `Thread '${scope.threadId}' was not found.`);
    }
    return projection.thread.projectId;
  });

  const mapWorkspaceError = Effect.mapError((error: unknown) =>
    failure("operation_failed", errorMessage(error)),
  );

  return ArtifactMcpService.of({
    list: (scope) =>
      Effect.gen(function* () {
        const projectId = yield* projectIdFor(scope);
        return { entries: [...(yield* artifacts.list(projectId).pipe(mapWorkspaceError))] };
      }),
    read: (scope, path) =>
      Effect.gen(function* () {
        const projectId = yield* projectIdFor(scope);
        return yield* artifacts.read({ projectId, relativePath: path }).pipe(mapWorkspaceError);
      }),
    write: (scope, input) =>
      Effect.gen(function* () {
        const projectId = yield* projectIdFor(scope);
        const artifact = yield* artifacts
          .write({ projectId, relativePath: input.path, content: input.content })
          .pipe(mapWorkspaceError);
        return { artifact, logicalPath: `artifacts/${artifact.path}` };
      }),
  });
});

export const layer = Layer.effect(ArtifactMcpService, make);
