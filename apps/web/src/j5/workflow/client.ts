import { Artifact, RunDetail, WorkflowDefinitionPresentation } from "@j5/workflow-contracts";
import {
  WorkflowApprovalCount,
  WorkflowEntries,
  WorkflowThreadParent,
} from "@j5/workflow-contracts/sidebar";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { browserCryptoLayer } from "../../cloud/dpop";
import { primaryEnvironmentHttpLayer } from "../../environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";

const runtime = ManagedRuntime.make(Layer.merge(primaryEnvironmentHttpLayer, browserCryptoLayer));
const RunResponse = Schema.Struct({ run: RunDetail });
const ArtifactResponse = Schema.Struct({ artifact: Artifact });

export class WorkflowHttpError extends Schema.TaggedErrorClass<WorkflowHttpError>()(
  "WorkflowHttpError",
  {
    status: Schema.Number,
    code: Schema.optional(Schema.String),
    detail: Schema.String,
  },
) {
  override get message() {
    return this.detail;
  }
}

const ErrorResponse = Schema.Struct({
  message: Schema.String,
  error: Schema.optional(
    Schema.Struct({
      code: Schema.String,
      detail: Schema.String,
    }),
  ),
});

const request = Effect.fn("workflow.request")(function* (path: string, body?: unknown) {
  const client = yield* HttpClient.HttpClient;
  const [pathname, query] = path.split("?");
  const target = new URL(resolvePrimaryEnvironmentHttpUrl(`/api/j5/workflows${pathname}`));
  target.search = query ?? "";
  const response =
    body === undefined
      ? yield* client.get(target.toString())
      : yield* client.execute(
          yield* HttpClientRequest.post(target.toString()).pipe(HttpClientRequest.bodyJson(body)),
        );
  if (response.status === 304) return response;
  if (response.status < 200 || response.status >= 300) {
    const error = yield* HttpClientResponse.schemaBodyJson(ErrorResponse)(response);
    return yield* new WorkflowHttpError({
      status: response.status,
      ...(error.error?.code === undefined ? {} : { code: error.error.code }),
      detail: error.error?.detail ?? error.message,
    });
  }
  return response;
});

export const readRun = (id: string, ifReadVersion?: number) =>
  runtime.runPromise(
    request(
      `/${encodeURIComponent(id)}${ifReadVersion === undefined ? "" : `?ifReadVersion=${ifReadVersion}`}`,
    ).pipe(
      Effect.flatMap((response) =>
        response.status === 304
          ? Effect.succeed(null)
          : HttpClientResponse.schemaBodyJson(RunResponse)(response).pipe(
              Effect.map((result) => result.run),
            ),
      ),
    ),
  );

export const readArtifact = (runId: string, artifactId: string) =>
  runtime.runPromise(
    request(`/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ArtifactResponse)),
      Effect.map((result) => result.artifact),
    ),
  );

export const mutateRun = async (path: string, body: unknown) => {
  const run = await runtime.runPromise(
    request(path, body).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(RunResponse)),
      Effect.map((result) => result.run),
    ),
  );
  window.dispatchEvent(new Event("j5-workflows-changed"));
  return run;
};

export const listWorkflowEntries = (
  squadronId: string,
  query = "",
  status = "",
  offset = 0,
  limit = 50,
) =>
  runtime.runPromise(
    request(
      `/sidebar?squadronId=${encodeURIComponent(squadronId)}&q=${encodeURIComponent(query)}&status=${encodeURIComponent(status)}&offset=${offset}&limit=${limit}`,
    ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(WorkflowEntries))),
  );

export const readWorkflowApprovalCount = () =>
  runtime.runPromise(
    request("/approval-count").pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(WorkflowApprovalCount)),
    ),
  );

export const listWorkflowDefinitions = () =>
  runtime.runPromise(
    request("/definitions").pipe(
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(
          Schema.Struct({ definitions: Schema.Array(WorkflowDefinitionPresentation) }),
        ),
      ),
      Effect.map((result) => result.definitions),
    ),
  );

export const readWorkflowThreadParent = (threadId: string) =>
  runtime.runPromise(
    request(`/thread-parent?threadId=${encodeURIComponent(threadId)}`).pipe(
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(
          Schema.Struct({ parent: Schema.NullOr(WorkflowThreadParent) }),
        ),
      ),
      Effect.map((result) => result.parent),
    ),
  );
