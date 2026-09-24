import {
  PLAYBOOK_PROGRESS_PATH,
  PLAYBOOK_RUNS_PATH,
  PlaybookRunsRequest,
  PlaybookRunsResponse,
  ThreadPlaybooksRequest,
  ThreadPlaybooksResponse,
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
} from "effect/unstable/http";
import { annotateEnvironmentRequest, failEnvironmentInternal } from "../../auth/http.ts";
import { authenticateClientRead, invalidRequest } from "../a2a/ClientReadsHttp.ts";
import { PlaybookStore } from "./PlaybookStore.ts";

const decodeRequest = Schema.decodeUnknownEffect(ThreadPlaybooksRequest);
const encodeResponse = Schema.encodeEffect(ThreadPlaybooksResponse);
const decodeRunsRequest = Schema.decodeUnknownEffect(PlaybookRunsRequest);
const encodeRunsResponse = Schema.encodeEffect(PlaybookRunsResponse);

export const playbookHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* PlaybookStore;
    const threadRoute = HttpRouter.add(
      "POST",
      PLAYBOOK_PROGRESS_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.playbooks.thread");
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* authenticateClientRead;
        const body = yield* Effect.result(request.json.pipe(Effect.flatMap(decodeRequest)));
        if (Result.isFailure(body)) return invalidRequest("A threadId is required.");
        return yield* store.listForThread(body.success.threadId).pipe(
          Effect.flatMap(encodeResponse),
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
    const runsRoute = HttpRouter.add(
      "POST",
      PLAYBOOK_RUNS_PATH,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.playbooks.runs");
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* authenticateClientRead;
        const body = yield* Effect.result(request.json.pipe(Effect.flatMap(decodeRunsRequest)));
        if (Result.isFailure(body))
          return invalidRequest("Use an active/all filter and a non-negative integer offset.");
        return yield* store.listAll(body.success).pipe(
          Effect.flatMap(encodeRunsResponse),
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
    return Layer.merge(threadRoute, runsRoute);
  }),
);
