import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  PLAYBOOK_LIBRARY_PATH,
  PlaybookLibraryRequest,
  PlaybookLibraryResponse,
} from "@t3tools/contracts/j5";
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
import { ProjectService } from "../../project/ProjectService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectionStoreThreadNotFoundError } from "../../orchestration-v2/ProjectionStore.ts";
import { PlaybookStore } from "./PlaybookStore.ts";

const decodeRequest = Schema.decodeUnknownEffect(PlaybookLibraryRequest);
const encodeResponse = Schema.encodeEffect(PlaybookLibraryResponse);
const isMissingThread = Schema.is(ProjectionStoreThreadNotFoundError);
const missing = () =>
  HttpServerResponse.jsonUnsafe(
    {
      error: "workspace_not_found",
      message: "This project or thread workspace is no longer available.",
    },
    { status: 404 },
  );

export const playbookLibraryHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* PlaybookStore;
    const projects = yield* ProjectService;
    const threads = yield* ThreadManagementService;
    return HttpRouter.add(
      "POST",
      PLAYBOOK_LIBRARY_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.playbooks.library");
        const request = yield* HttpServerRequest.HttpServerRequest;
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const session = yield* auth.authenticateHttpRequest(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        if (!session.scopes.includes(AuthOrchestrationReadScope))
          return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
        const body = yield* Effect.result(request.json.pipe(Effect.flatMap(decodeRequest)));
        if (Result.isFailure(body))
          return HttpServerResponse.jsonUnsafe(
            {
              error: "invalid_request",
              message: "Select a project and optionally a thread workspace.",
            },
            { status: 400 },
          );
        const project = yield* projects
          .getById(body.success.projectId)
          .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        if (Option.isNone(project) || project.value.deletedAt !== null) return missing();
        let workspaceRoot = project.value.workspaceRoot;
        if (body.success.threadId !== undefined) {
          const projection = yield* threads.getThreadProjection(body.success.threadId).pipe(
            Effect.catchTag("OrchestratorProjectionError", (error) =>
              isMissingThread(error.cause) ? Effect.succeed(null) : Effect.fail(error),
            ),
            Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
          );
          if (
            !projection ||
            projection.thread.deletedAt !== null ||
            projection.thread.projectId !== project.value.id
          )
            return missing();
          workspaceRoot = projection.thread.worktreePath ?? workspaceRoot;
        }
        return yield* store.discover(workspaceRoot).pipe(
          Effect.flatMap((library) => encodeResponse({ workspaceRoot, ...library })),
          Effect.map((data) => HttpServerResponse.jsonUnsafe(data)),
          Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);
