import {
  AnswerHumanExchangeResponse,
  CreateSquadronResponse,
  CrewMembershipsResponse,
  CrewProposalResolveResponse,
  CrewProposalPreviewResponse,
  CrewProposalsResponse,
  CrewArchiveResponse,
  CrewStopResponse,
  FleetResponse,
  HumanInboxResponse,
  J5_API_PATHS,
  OpenInboxCountResponse,
  SpawnedChildrenResponse,
  SquadronListResponse,
  ThreadHomesResponse,
  type AnswerHumanExchangeRequest,
  type CrewProposalResolveRequest,
  type CrewProposalPreviewRequest,
  type CrewArchiveRequest,
  type CrewStopRequest,
  type FleetReadRequest,
} from "@t3tools/contracts/j5";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";

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

const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 15_000;

/**
 * Authorizes against this prepared environment only, through the same
 * request-time credential resolution the client uses for its other
 * authenticated HTTP reads: cookies for the browser's own server, a static
 * bearer token, or a relay access token with a fresh DPoP proof per request.
 * A relay token the server rejects gets one refresh and retry.
 */
export const executeJ5Request = Effect.fn("j5.http.executeRequest")(function* (
  prepared: PreparedConnection,
  request: HttpClientRequest.HttpClientRequest,
  timeoutMs: number,
) {
  const client = yield* HttpClient.HttpClient;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  // `request.url` is a path plus optional query; the origin is resolved per
  // attempt because a relay refresh can move the environment to a new one.
  const path = new URL(request.url, "http://environment.invalid");
  const resolveUrl = (httpBaseUrl: string) => {
    const url = new URL(environmentEndpointUrl(httpBaseUrl, path.pathname));
    url.search = path.search;
    return url.toString();
  };
  let requestUrl = resolveUrl(prepared.httpBaseUrl);
  const response = yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: request.method,
    url: (httpBaseUrl) => (requestUrl = resolveUrl(httpBaseUrl)),
    timeoutMs,
    request: ({ headers }) =>
      client.execute(
        HttpClientRequest.setHeaders(HttpClientRequest.setUrl(request, requestUrl), {
          ...headers,
        }),
      ),
    isUnauthorizedResponse: (response) => response.status === 401,
  });
  if (response.status >= 200 && response.status < 300) return response;
  const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
  const decoded = Option.getOrUndefined(decodeErrorResponse(body));
  return yield* new J5HttpError({
    status: response.status,
    detail: decoded?.message ?? `J5 request failed (HTTP ${response.status}).`,
    ...(decoded?.error === undefined ? {} : { code: decoded.error }),
  });
});

export const listSquadrons = Effect.fn("j5.http.listSquadrons")(function* (
  prepared: PreparedConnection,
) {
  const response = yield* executeJ5Request(
    prepared,
    HttpClientRequest.get(J5_API_PATHS.squadrons),
    READ_TIMEOUT_MS,
  );
  return (yield* HttpClientResponse.schemaBodyJson(SquadronListResponse)(response)).squadrons;
});

export const createSquadron = Effect.fn("j5.http.createSquadron")(function* (
  prepared: PreparedConnection,
  input: { readonly name: string; readonly projectId: ProjectId },
) {
  const request = yield* HttpClientRequest.post(J5_API_PATHS.squadrons).pipe(
    HttpClientRequest.bodyJson(input),
  );
  const response = yield* executeJ5Request(prepared, request, WRITE_TIMEOUT_MS);
  return (yield* HttpClientResponse.schemaBodyJson(CreateSquadronResponse)(response)).squadron;
});

export const listThreadHomes = Effect.fn("j5.http.listThreadHomes")(function* (
  prepared: PreparedConnection,
  threadIds: ReadonlyArray<ThreadId>,
) {
  const request = yield* HttpClientRequest.post(J5_API_PATHS.threadHomes).pipe(
    HttpClientRequest.bodyJson({ threadIds: [...new Set(threadIds)] }),
  );
  const response = yield* executeJ5Request(prepared, request, READ_TIMEOUT_MS);
  return (yield* HttpClientResponse.schemaBodyJson(ThreadHomesResponse)(response)).entries;
});

export const listHumanInbox = Effect.fn("j5.http.listHumanInbox")(function* (
  prepared: PreparedConnection,
  status: "open" | "answered",
  personId?: string,
) {
  const query = new URLSearchParams({ status });
  if (personId !== undefined) query.set("personId", personId);
  const response = yield* executeJ5Request(
    prepared,
    HttpClientRequest.get(`${J5_API_PATHS.inbox}?${query.toString()}`),
    READ_TIMEOUT_MS,
  );
  return yield* HttpClientResponse.schemaBodyJson(HumanInboxResponse)(response);
});

export const readOpenInboxCount = Effect.fn("j5.http.readOpenInboxCount")(function* (
  prepared: PreparedConnection,
  personId?: string,
) {
  const request = yield* HttpClientRequest.post(J5_API_PATHS.openCount).pipe(
    HttpClientRequest.bodyJson(personId === undefined ? {} : { personId }),
  );
  const response = yield* executeJ5Request(prepared, request, READ_TIMEOUT_MS);
  return yield* HttpClientResponse.schemaBodyJson(OpenInboxCountResponse)(response);
});

export const answerHumanExchange = Effect.fn("j5.http.answerHumanExchange")(function* (
  prepared: PreparedConnection,
  input: AnswerHumanExchangeRequest,
) {
  const request = yield* HttpClientRequest.post(J5_API_PATHS.answer).pipe(
    HttpClientRequest.bodyJson(input),
  );
  const response = yield* executeJ5Request(prepared, request, WRITE_TIMEOUT_MS);
  return yield* HttpClientResponse.schemaBodyJson(AnswerHumanExchangeResponse)(response);
});

export const listCrewProposals = Effect.fn("j5.http.listCrewProposals")(function* (
  prepared: PreparedConnection,
) {
  const request = yield* HttpClientRequest.post(J5_API_PATHS.crewProposals).pipe(
    HttpClientRequest.bodyJson({}),
  );
  const response = yield* executeJ5Request(prepared, request, READ_TIMEOUT_MS);
  return (yield* HttpClientResponse.schemaBodyJson(CrewProposalsResponse)(response)).proposals;
});

export const previewCrewProposal = Effect.fn("j5.http.previewCrewProposal")(function* (
  prepared: PreparedConnection,
  input: CrewProposalPreviewRequest,
) {
  const request = yield* HttpClientRequest.post(J5_API_PATHS.crewProposalPreview).pipe(
    HttpClientRequest.bodyJson(input),
  );
  const response = yield* executeJ5Request(prepared, request, READ_TIMEOUT_MS);
  return yield* HttpClientResponse.schemaBodyJson(CrewProposalPreviewResponse)(response);
});

export const resolveCrewProposal = Effect.fn("j5.http.resolveCrewProposal")(function* (
  prepared: PreparedConnection,
  input: CrewProposalResolveRequest,
) {
  const request = yield* HttpClientRequest.post(J5_API_PATHS.crewProposalResolve).pipe(
    HttpClientRequest.bodyJson(input),
  );
  const response = yield* executeJ5Request(prepared, request, WRITE_TIMEOUT_MS);
  return yield* HttpClientResponse.schemaBodyJson(CrewProposalResolveResponse)(response);
});

export const readFleet = Effect.fn("j5.http.readFleet")(function* (
  prepared: PreparedConnection,
  input: FleetReadRequest = {},
) {
  const request = yield* HttpClientRequest.post(J5_API_PATHS.fleet).pipe(
    HttpClientRequest.bodyJson(input),
  );
  const response = yield* executeJ5Request(prepared, request, READ_TIMEOUT_MS);
  return yield* HttpClientResponse.schemaBodyJson(FleetResponse)(response);
});

export const listCrewMemberships = Effect.fn("j5.http.listCrewMemberships")(function* (
  prepared: PreparedConnection,
  threadIds: ReadonlyArray<ThreadId>,
) {
  const request = yield* HttpClientRequest.post(J5_API_PATHS.crewMemberships).pipe(
    HttpClientRequest.bodyJson({ threadIds: [...new Set(threadIds)] }),
  );
  const response = yield* executeJ5Request(prepared, request, READ_TIMEOUT_MS);
  return (yield* HttpClientResponse.schemaBodyJson(CrewMembershipsResponse)(response)).entries;
});

export const listSpawnedChildren = Effect.fn("j5.http.listSpawnedChildren")(function* (
  prepared: PreparedConnection,
  threadIds: ReadonlyArray<ThreadId>,
) {
  const request = yield* HttpClientRequest.post(J5_API_PATHS.spawnedChildren).pipe(
    HttpClientRequest.bodyJson({ threadIds: [...new Set(threadIds)] }),
  );
  const response = yield* executeJ5Request(prepared, request, READ_TIMEOUT_MS);
  return (yield* HttpClientResponse.schemaBodyJson(SpawnedChildrenResponse)(response)).entries;
});

export const archiveCrew = Effect.fn("j5.http.archiveCrew")(function* (
  prepared: PreparedConnection,
  input: CrewArchiveRequest,
) {
  const request = yield* HttpClientRequest.post(J5_API_PATHS.crewArchive).pipe(
    HttpClientRequest.bodyJson(input),
  );
  const response = yield* executeJ5Request(prepared, request, WRITE_TIMEOUT_MS);
  return yield* HttpClientResponse.schemaBodyJson(CrewArchiveResponse)(response);
});

export const stopCrew = Effect.fn("j5.http.stopCrew")(function* (
  prepared: PreparedConnection,
  input: CrewStopRequest,
) {
  const request = yield* HttpClientRequest.post(J5_API_PATHS.crewStop).pipe(
    HttpClientRequest.bodyJson(input),
  );
  const response = yield* executeJ5Request(prepared, request, WRITE_TIMEOUT_MS);
  return yield* HttpClientResponse.schemaBodyJson(CrewStopResponse)(response);
});
