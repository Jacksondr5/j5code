import {
  AnswerHumanExchangeResponse,
  CreateSquadronResponse,
  HumanInboxResponse,
  J5_API_PATHS,
  OpenInboxCountResponse,
  SquadronListResponse,
  ThreadHomesResponse,
  type AnswerHumanExchangeRequest,
} from "@t3tools/contracts/j5";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  buildEnvironmentAuthHeaders,
  withEnvironmentCredentials,
} from "../state/environmentHttpAuth.ts";

const ErrorResponse = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
const decodeErrorResponse = Schema.decodeUnknownOption(ErrorResponse);

export class J5HttpError extends Schema.TaggedErrorClass<J5HttpError>()("J5HttpError", {
  status: Schema.Number,
  detail: Schema.String,
  code: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    return this.detail;
  }
}

const isJ5HttpError = Schema.is(J5HttpError);

/** An absent route is unsupported; a missing person or other domain resource is an error. */
export const isJ5UnsupportedError = (error: unknown): boolean =>
  isJ5HttpError(error) &&
  (error.status === 501 ||
    (error.status === 404 && (error.code === undefined || error.code === "not_found")));

/** Authorizes against this prepared environment only, including a fresh relay proof per request. */
export const executeJ5Request = Effect.fn("j5.http.executeRequest")(function* (
  prepared: PreparedConnection,
  request: HttpClientRequest.HttpClientRequest,
) {
  const client = yield* HttpClient.HttpClient;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const headers = yield* buildEnvironmentAuthHeaders(
    prepared.httpAuthorization,
    request.method,
    request.url,
    signer,
  );
  const response = yield* withEnvironmentCredentials(
    prepared.httpAuthorization,
    client.execute(HttpClientRequest.setHeaders(request, { ...headers })),
  );
  if (response.status >= 200 && response.status < 300) return response;
  const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
  const decoded = Option.getOrUndefined(decodeErrorResponse(body));
  return yield* new J5HttpError({
    status: response.status,
    detail: decoded?.message ?? `J5 request failed (HTTP ${response.status}).`,
    ...(decoded?.error === undefined ? {} : { code: decoded.error }),
  });
});

export const listSquadrons = Effect.fn("j5.http.listSquadrons")(
  function* (prepared: PreparedConnection) {
    const response = yield* executeJ5Request(
      prepared,
      HttpClientRequest.get(environmentEndpointUrl(prepared.httpBaseUrl, J5_API_PATHS.squadrons)),
    );
    return (yield* HttpClientResponse.schemaBodyJson(SquadronListResponse)(response)).squadrons;
  },
  Effect.timeout(Duration.seconds(10)),
);

export const createSquadron = Effect.fn("j5.http.createSquadron")(
  function* (
    prepared: PreparedConnection,
    input: { readonly name: string; readonly projectId: ProjectId },
  ) {
    const request = yield* HttpClientRequest.post(
      environmentEndpointUrl(prepared.httpBaseUrl, J5_API_PATHS.squadrons),
    ).pipe(HttpClientRequest.bodyJson(input));
    const response = yield* executeJ5Request(prepared, request);
    return (yield* HttpClientResponse.schemaBodyJson(CreateSquadronResponse)(response)).squadron;
  },
  Effect.timeout(Duration.seconds(15)),
);

export const listThreadHomes = Effect.fn("j5.http.listThreadHomes")(
  function* (prepared: PreparedConnection, threadIds: ReadonlyArray<ThreadId>) {
    const request = yield* HttpClientRequest.post(
      environmentEndpointUrl(prepared.httpBaseUrl, J5_API_PATHS.threadHomes),
    ).pipe(HttpClientRequest.bodyJson({ threadIds: [...new Set(threadIds)] }));
    const response = yield* executeJ5Request(prepared, request);
    return (yield* HttpClientResponse.schemaBodyJson(ThreadHomesResponse)(response)).entries;
  },
  Effect.timeout(Duration.seconds(10)),
);

export const listHumanInbox = Effect.fn("j5.http.listHumanInbox")(
  function* (prepared: PreparedConnection, status: "open" | "answered", personId?: string) {
    const url = new URL(environmentEndpointUrl(prepared.httpBaseUrl, J5_API_PATHS.inbox));
    url.searchParams.set("status", status);
    if (personId !== undefined) url.searchParams.set("personId", personId);
    const response = yield* executeJ5Request(prepared, HttpClientRequest.get(url.toString()));
    return yield* HttpClientResponse.schemaBodyJson(HumanInboxResponse)(response);
  },
  Effect.timeout(Duration.seconds(10)),
);

export const readOpenInboxCount = Effect.fn("j5.http.readOpenInboxCount")(
  function* (prepared: PreparedConnection, personId?: string) {
    const request = yield* HttpClientRequest.post(
      environmentEndpointUrl(prepared.httpBaseUrl, J5_API_PATHS.openCount),
    ).pipe(HttpClientRequest.bodyJson(personId === undefined ? {} : { personId }));
    const response = yield* executeJ5Request(prepared, request);
    return yield* HttpClientResponse.schemaBodyJson(OpenInboxCountResponse)(response);
  },
  Effect.timeout(Duration.seconds(10)),
);

export const answerHumanExchange = Effect.fn("j5.http.answerHumanExchange")(
  function* (prepared: PreparedConnection, input: AnswerHumanExchangeRequest) {
    const request = yield* HttpClientRequest.post(
      environmentEndpointUrl(prepared.httpBaseUrl, J5_API_PATHS.answer),
    ).pipe(HttpClientRequest.bodyJson(input));
    const response = yield* executeJ5Request(prepared, request);
    return yield* HttpClientResponse.schemaBodyJson(AnswerHumanExchangeResponse)(response);
  },
  Effect.timeout(Duration.seconds(15)),
);
