import {
  ARTIFACT_LIST_PATH,
  ARTIFACT_READ_PATH,
  ArtifactListRequest,
  ArtifactReadRequest,
  AuthOrchestrationReadScope,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { ArtifactWorkspace } from "./ArtifactWorkspace.ts";

const decodeListRequest = Schema.decodeUnknownEffect(ArtifactListRequest);
const decodeReadRequest = Schema.decodeUnknownEffect(ArtifactReadRequest);

const authenticateRead = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationReadScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
  }
});

const requestFailure = (message: string) =>
  HttpServerResponse.jsonUnsafe({ error: "invalid_request", message }, { status: 400 });

const operationFailure = (cause: unknown) => {
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause
      ? String(cause._tag)
      : "ArtifactReadError";
  const detail = cause instanceof Error ? cause.message : "Artifact lookup failed.";
  const status =
    tag === "ArtifactProjectUnavailableError"
      ? 404
      : tag === "ArtifactWorkspaceError" && detail.includes("does not exist")
        ? 404
        : tag === "ArtifactWorkspaceError"
          ? 409
          : 500;
  return status === 500
    ? Effect.logError("J5 artifact read failed", { cause }).pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            { error: tag, message: "Artifact lookup failed." },
            { status },
          ),
        ),
      )
    : Effect.succeed(HttpServerResponse.jsonUnsafe({ error: tag, message: detail }, { status }));
};

const resolveProjectCwd = Effect.fn("j5.artifacts.resolveProjectCwd")(function* (
  projects: ProjectService.ProjectService["Service"],
  projectId: ProjectId,
) {
  const project = yield* projects.getById(projectId);
  if (Option.isNone(project)) {
    return yield* new ArtifactProjectUnavailableError({ projectId });
  }
  return project.value.workspaceRoot;
});

class ArtifactProjectUnavailableError extends Schema.TaggedErrorClass<ArtifactProjectUnavailableError>()(
  "ArtifactProjectUnavailableError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} does not have an available workspace.`;
  }
}

/** Authenticated J5 routes keep ignored artifact files outside the workspace search index. */
export const artifactHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const artifacts = yield* ArtifactWorkspace;
    const projects = yield* ProjectService.ProjectService;

    const listRoute = HttpRouter.add(
      "POST",
      ARTIFACT_LIST_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.artifacts.list");
        yield* authenticateRead;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* Effect.result(request.json);
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeListRequest(body.success));
        if (Result.isFailure(decoded)) return requestFailure("A valid projectId is required.");
        const input = decoded.success;
        const result = yield* Effect.result(
          resolveProjectCwd(projects, input.projectId).pipe(Effect.flatMap(artifacts.list)),
        );
        return Result.isSuccess(result)
          ? HttpServerResponse.jsonUnsafe({ entries: result.success })
          : yield* operationFailure(result.failure);
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      ),
    );

    const readRoute = HttpRouter.add(
      "POST",
      ARTIFACT_READ_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.artifacts.read");
        yield* authenticateRead;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* Effect.result(request.json);
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeReadRequest(body.success));
        if (Result.isFailure(decoded))
          return requestFailure("A valid projectId and artifact path are required.");
        const input = decoded.success;
        const result = yield* Effect.result(
          resolveProjectCwd(projects, input.projectId).pipe(
            Effect.flatMap((cwd) => artifacts.read({ cwd, relativePath: input.path })),
          ),
        );
        return Result.isSuccess(result)
          ? HttpServerResponse.jsonUnsafe(result.success)
          : yield* operationFailure(result.failure);
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      ),
    );

    return Layer.mergeAll(listRoute, readRoute);
  }),
);
