import {
  PLAYBOOK_LIBRARY_PATH,
  PlaybookLibraryRequest,
  PlaybookLibraryResponse,
} from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import { annotateEnvironmentRequest, failEnvironmentInternal } from "../../auth/http.ts";
import { authenticateClientRead, invalidRequest } from "../a2a/ClientReadsHttp.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { PlaybookStore } from "./PlaybookStore.ts";
import { resolvePlaybookWorkspaceRoot } from "./workspaceRoot.ts";

const decodeRequest = Schema.decodeUnknownEffect(PlaybookLibraryRequest);
const encodeResponse = Schema.encodeEffect(PlaybookLibraryResponse);
const missing = () =>
  HttpServerResponse.jsonUnsafe(
    {
      error: "workspace_not_found",
      message: "This project or thread workspace is no longer available.",
    },
    { status: 404 },
  );
/** The playbook library's read. Deleting and renaming a definition are RPCs (`playbookRpc.ts`). */
export const playbookLibraryHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* PlaybookStore;
    const projects = yield* ProjectService;
    const threads = yield* ThreadManagementService;
    const workspaceRoot = (input: PlaybookLibraryRequest) =>
      resolvePlaybookWorkspaceRoot(projects, threads, input).pipe(
        Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
      );
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
    return libraryRoute;
  }),
);
