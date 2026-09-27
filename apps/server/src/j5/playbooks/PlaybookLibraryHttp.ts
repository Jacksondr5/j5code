import {
  PLAYBOOK_DELETE_PATH,
  PLAYBOOK_LIBRARY_PATH,
  PLAYBOOK_RENAME_PATH,
  PlaybookDeleteRequest,
  PlaybookDeleteResponse,
  PlaybookError,
  PlaybookLibraryRequest,
  PlaybookLibraryResponse,
  PlaybookRenameRequest,
  PlaybookRenameResponse,
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
import { annotateEnvironmentRequest, failEnvironmentInternal } from "../../auth/http.ts";
import {
  authenticateClientRead,
  authenticateOperate,
  invalidRequest,
} from "../a2a/ClientReadsHttp.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectionStoreThreadNotFoundError } from "../../orchestration-v2/ProjectionStore.ts";
import { PlaybookStore } from "./PlaybookStore.ts";

const decodeRequest = Schema.decodeUnknownEffect(PlaybookLibraryRequest);
const encodeResponse = Schema.encodeEffect(PlaybookLibraryResponse);
const decodeDeleteRequest = Schema.decodeUnknownEffect(PlaybookDeleteRequest);
const encodeDeleteResponse = Schema.encodeEffect(PlaybookDeleteResponse);
const decodeRenameRequest = Schema.decodeUnknownEffect(PlaybookRenameRequest);
const encodeRenameResponse = Schema.encodeEffect(PlaybookRenameResponse);
const isPlaybookError = Schema.is(PlaybookError);
const isMissingThread = Schema.is(ProjectionStoreThreadNotFoundError);
const missing = () =>
  HttpServerResponse.jsonUnsafe(
    {
      error: "workspace_not_found",
      message: "This project or thread workspace is no longer available.",
    },
    { status: 404 },
  );
const mutationError = (error: unknown) => {
  if (!isPlaybookError(error)) return failEnvironmentInternal("internal_error", error);
  const status =
    error.code === "not_found"
      ? 404
      : error.code === "in_use"
        ? 409
        : error.code === "invalid_name" ||
            error.code === "invalid_title" ||
            error.code === "invalid_path" ||
            error.code === "invalid_definition"
          ? 400
          : 500;
  return status === 500
    ? failEnvironmentInternal("internal_error", error)
    : Effect.succeed(
        HttpServerResponse.jsonUnsafe({ error: error.code, message: error.message }, { status }),
      );
};

export const playbookLibraryHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* PlaybookStore;
    const projects = yield* ProjectService;
    const threads = yield* ThreadManagementService;
    const workspaceRoot = (input: PlaybookLibraryRequest) =>
      Effect.gen(function* () {
        const project = yield* projects
          .getById(input.projectId)
          .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
        if (Option.isNone(project) || project.value.deletedAt !== null) return null;
        let root = project.value.workspaceRoot;
        if (input.threadId !== undefined) {
          const projection = yield* threads.getThreadProjection(input.threadId).pipe(
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
            return null;
          root = projection.thread.worktreePath ?? root;
        }
        return root;
      });
    const libraryRoute = HttpRouter.add(
      "POST",
      PLAYBOOK_LIBRARY_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.playbooks.library");
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* authenticateClientRead;
        const body = yield* Effect.result(request.json.pipe(Effect.flatMap(decodeRequest)));
        if (Result.isFailure(body))
          return invalidRequest("Select a project and optionally a thread workspace.");
        const root = yield* workspaceRoot(body.success);
        if (root === null) return missing();
        return yield* store.discover(root).pipe(
          Effect.flatMap((library) => encodeResponse({ workspaceRoot: root, ...library })),
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
    const deleteRoute = HttpRouter.add(
      "POST",
      PLAYBOOK_DELETE_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.playbooks.delete");
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* authenticateOperate;
        const body = yield* Effect.result(request.json.pipe(Effect.flatMap(decodeDeleteRequest)));
        if (Result.isFailure(body)) return invalidRequest("Select a playbook in this workspace.");
        const root = yield* workspaceRoot(body.success);
        if (root === null) return missing();
        return yield* store.removeDefinition(root, body.success.name).pipe(
          Effect.flatMap(encodeDeleteResponse),
          Effect.map((data) => HttpServerResponse.jsonUnsafe(data)),
          Effect.catch(mutationError),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      ),
    );
    const renameRoute = HttpRouter.add(
      "POST",
      PLAYBOOK_RENAME_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.playbooks.rename");
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* authenticateOperate;
        const body = yield* Effect.result(request.json.pipe(Effect.flatMap(decodeRenameRequest)));
        if (Result.isFailure(body))
          return invalidRequest("Choose a playbook and enter its new name.");
        const root = yield* workspaceRoot(body.success);
        if (root === null) return missing();
        return yield* store.renameDefinition(root, body.success.name, body.success.title).pipe(
          Effect.flatMap(encodeRenameResponse),
          Effect.map((data) => HttpServerResponse.jsonUnsafe(data)),
          Effect.catch(mutationError),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      ),
    );
    return Layer.mergeAll(libraryRoute, deleteRoute, renameRoute);
  }),
);
