import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import {
  AssignImportedThreadsRequest,
  type AssignImportedThreadsResponse,
  J5_API_PATHS,
} from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
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

import { annotateEnvironmentRequest } from "../../auth/http.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { A2AHomeRegistrar } from "./HomeRegistrar.ts";
import { SquadronJoinProjectReferenceError, SquadronJoinService } from "./SquadronJoinService.ts";
import { SquadronProjectNotFoundError } from "./SquadronManagementService.ts";
import { SquadronProjectReferences } from "./SquadronProjectReferences.ts";
import { authenticate, operationFailure, requestFailure } from "./SquadronHttp.ts";
import { CommCommandId, SquadronId } from "./contracts.ts";
import { PlacementCommandId } from "./placementContracts.ts";

const decodeRequest = Schema.decodeUnknownEffect(AssignImportedThreadsRequest);

/** Explicit onboarding assignment also repairs earlier unhomed imports in this project. */
export const assignImportedThreads = Effect.fn("j5.assignImportedThreads")(function* (
  input: AssignImportedThreadsRequest,
) {
  const projects = yield* ProjectService;
  const references = yield* SquadronProjectReferences;
  const threads = yield* ThreadManagementService;
  const homes = yield* A2AHomeRegistrar;
  const join = yield* SquadronJoinService;
  const squadronId = SquadronId.make(input.squadronId);
  if (Option.isNone(yield* projects.getById(input.projectId))) {
    return yield* new SquadronProjectNotFoundError({ projectId: input.projectId });
  }
  // Validate even an empty import, before reporting it successfully assigned.
  const projectRefs = yield* references.listForSquadron(squadronId);
  if (projectRefs.length !== 1 || projectRefs[0]?.projectId !== input.projectId) {
    return yield* new SquadronJoinProjectReferenceError({
      squadronId,
      projectId: input.projectId,
      referencedProjectIds: projectRefs.map((reference) => reference.projectId),
    });
  }
  const candidates = (yield* threads.listProjectThreads({
    projectId: input.projectId,
    includeSubagents: false,
  })).filter((thread) => thread.historyOrigin === "v1_import" && thread.deletedAt === null);
  const entries: Array<AssignImportedThreadsResponse["entries"][number]> = [];
  for (const candidate of candidates) {
    const outcome = yield* Effect.result(
      Effect.gen(function* () {
        // Read only the shell; assigning a folder does not need every conversation's history.
        const thread = yield* threads.getThreadShell(candidate.id);
        if (
          thread === null ||
          thread.deletedAt !== null ||
          thread.projectId !== input.projectId ||
          thread.historyOrigin !== "v1_import"
        )
          return "failed" as const;
        if (thread.archivedAt !== null) return "kept_archived" as const;
        const home = yield* homes
          .getHomeForThread(thread.id)
          .pipe(Effect.catchTag("A2AHomeNotFoundError", () => Effect.succeed(null)));
        const commandKey = `${encodeURIComponent(squadronId)}:${encodeURIComponent(thread.id)}`;
        yield* join.joinExistingThread({
          projectId: input.projectId,
          squadronId,
          threadId: thread.id,
          homeCommandId: CommCommandId.make(`command:j5:onboarding-home:${commandKey}`),
          placementCommandId: PlacementCommandId.make(
            `command:j5:onboarding-placement:${commandKey}`,
          ),
          joinedAt: DateTime.formatIso(yield* DateTime.now),
        });
        return home === null ? ("assigned" as const) : ("already_assigned" as const);
      }),
    );
    if (Result.isSuccess(outcome)) {
      entries.push({ threadId: candidate.id, status: outcome.success });
    } else if (outcome.failure._tag === "A2AHomeConflictError") {
      entries.push({ threadId: candidate.id, status: "kept_elsewhere" });
    } else if (outcome.failure._tag === "SquadronJoinRetiredError") {
      entries.push({ threadId: candidate.id, status: "kept_retired" });
    } else {
      yield* Effect.logError("J5 imported conversation assignment failed", {
        threadId: candidate.id,
        cause: outcome.failure,
      });
      entries.push({ threadId: candidate.id, status: "failed" });
    }
  }
  return { entries } satisfies AssignImportedThreadsResponse;
});

export const importedThreadsHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const assignmentContext =
      yield* Effect.context<Effect.Services<ReturnType<typeof assignImportedThreads>>>();
    return HttpRouter.add(
      "POST",
      J5_API_PATHS.assignImportedThreads,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.squadron.assignImported");
        yield* authenticate(AuthOrchestrationOperateScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* Effect.result(request.json);
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeRequest(body.success));
        if (Result.isFailure(decoded))
          return requestFailure("A Squadron and existing project are required.");
        const result = yield* Effect.result(
          assignImportedThreads(decoded.success).pipe(Effect.provide(assignmentContext)),
        );
        if (Result.isFailure(result)) return yield* operationFailure(result.failure);
        return HttpServerResponse.jsonUnsafe(result.success);
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
