import { WorkflowEntries, WorkflowThreadParent } from "@j5/workflow-contracts/sidebar";
import { Run, RunSummary, WorkflowDefinitionPresentation } from "@j5/workflow-contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { browserCryptoLayer } from "../../cloud/dpop";
import { primaryEnvironmentHttpLayer } from "../../environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";

const runtime = ManagedRuntime.make(Layer.merge(primaryEnvironmentHttpLayer, browserCryptoLayer));
const Response = Schema.Struct({ run: Run });
export function normalizeWorkflowEntries(result: typeof WorkflowEntries.Type, offset: number) {
  return {
    ...result,
    // Older servers expose hasMore but not the accurate total. Keep history
    // reachable without pretending the lower bound is an exact count.
    total: result.total ?? offset + result.runs.length + (result.hasMore ? 1 : 0),
    waitingApprovalCount: result.waitingApprovalCount ?? null,
  };
}
class WorkflowHttpError extends Schema.TaggedErrorClass<WorkflowHttpError>()("WorkflowHttpError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}
const request = Effect.fn("workflow.request")(function* (path: string, body?: unknown) {
  const client = yield* HttpClient.HttpClient;
  const [pathname, query] = path.split("?");
  const target = new URL(resolvePrimaryEnvironmentHttpUrl(`/api/j5/workflows${pathname}`));
  target.search = query ?? "";
  const url = target.toString();
  const response =
    body === undefined
      ? yield* client.get(url)
      : yield* client.execute(
          yield* HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJson(body)),
        );
  if (response.status < 200 || response.status >= 300) {
    const error = yield* HttpClientResponse.schemaBodyJson(
      Schema.Struct({ message: Schema.String }),
    )(response);
    return yield* new WorkflowHttpError({ detail: error.message });
  }
  return response;
});
export const listRuns = (squadronId: string) =>
  runtime.runPromise(
    request(`?squadronId=${encodeURIComponent(squadronId)}`).pipe(
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(Schema.Struct({ runs: Schema.Array(RunSummary) })),
      ),
      Effect.map((result) => result.runs),
    ),
  );
export const readRun = (id: string) =>
  runtime.runPromise(
    request(`/${encodeURIComponent(id)}`).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Response)),
      Effect.map((result) => result.run),
    ),
  );
export const mutateRun = async (path: string, body: unknown) => {
  const run = await runtime.runPromise(
    request(path, body).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Response)),
      Effect.map((result) => result.run),
    ),
  );
  window.dispatchEvent(new Event("j5-workflows-changed"));
  return run;
};

export const listWorkflowEntries = (squadronId: string, query = "", offset = 0, limit = 50) =>
  runtime.runPromise(
    request(
      `/sidebar?squadronId=${encodeURIComponent(squadronId)}&q=${encodeURIComponent(query)}&offset=${offset}&limit=${limit}`,
    ).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(WorkflowEntries)),
      Effect.map((result) => normalizeWorkflowEntries(result, offset)),
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
