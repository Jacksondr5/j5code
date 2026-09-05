import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { browserCryptoLayer } from "../../cloud/dpop";
import { primaryEnvironmentHttpLayer } from "../../environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";

const ManagedSquadron = Schema.Struct({
  squadron: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    createdAt: Schema.String,
  }),
  projectIds: Schema.Array(ProjectId),
});
export type ManagedSquadron = typeof ManagedSquadron.Type;

const SquadronListResponse = Schema.Struct({ squadrons: Schema.Array(ManagedSquadron) });
const CreateSquadronResponse = Schema.Struct({ squadron: ManagedSquadron });
const runtime = ManagedRuntime.make(Layer.merge(primaryEnvironmentHttpLayer, browserCryptoLayer));

const ErrorResponse = Schema.Struct({ message: Schema.String });
const decodeErrorResponse = Schema.decodeUnknownOption(ErrorResponse);

export class SquadronHttpError extends Schema.TaggedErrorClass<SquadronHttpError>()(
  "SquadronHttpError",
  { status: Schema.Number, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const requireSquadronSuccess = Effect.fn("j5.squadronClient.requireSuccess")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  if (response.status >= 200 && response.status < 300) return response;
  const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
  const decoded = Option.getOrUndefined(decodeErrorResponse(body));
  return yield* new SquadronHttpError({
    status: response.status,
    detail: decoded?.message ?? `Could not load Squadrons (HTTP ${response.status}).`,
  });
});

export const listSquadronsEffect = Effect.fn("j5.squadronClient.list")(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get(resolvePrimaryEnvironmentHttpUrl("/api/j5/squadrons"));
  const success = yield* requireSquadronSuccess(response);
  return (yield* HttpClientResponse.schemaBodyJson(SquadronListResponse)(success)).squadrons;
});

export const listSquadrons = (): Promise<ReadonlyArray<ManagedSquadron>> =>
  runtime.runPromise(listSquadronsEffect());

export const createSquadronEffect = Effect.fn("j5.squadronClient.create")(function* (input: {
  readonly name: string;
  readonly projectId: ProjectId;
}) {
  const client = yield* HttpClient.HttpClient;
  const request = yield* HttpClientRequest.post(
    resolvePrimaryEnvironmentHttpUrl("/api/j5/squadrons"),
  ).pipe(HttpClientRequest.bodyJson(input));
  const response = yield* client.execute(request);
  const success = yield* requireSquadronSuccess(response);
  return (yield* HttpClientResponse.schemaBodyJson(CreateSquadronResponse)(success)).squadron;
});

export const createSquadron = (input: { readonly name: string; readonly projectId: ProjectId }) =>
  runtime.runPromise(createSquadronEffect(input));
