import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  ARTIFACT_LIST_PATH,
  ARTIFACT_READ_PATH,
  ArtifactContent,
  ArtifactListResponse,
  type ArtifactContent as ArtifactContentValue,
  type ArtifactEntry,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";

const ErrorResponse = Schema.Struct({ message: Schema.String });
const decodeErrorResponse = Schema.decodeUnknownOption(ErrorResponse);

export class ArtifactHttpError extends Schema.TaggedErrorClass<ArtifactHttpError>()(
  "ArtifactHttpError",
  { status: Schema.Number, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const requireSuccess = Effect.fn("j5.artifacts.client.requireSuccess")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  if (response.status >= 200 && response.status < 300) return response;
  const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
  const decoded = Option.getOrUndefined(decodeErrorResponse(body));
  return yield* new ArtifactHttpError({
    status: response.status,
    detail: decoded?.message ?? `Artifact request failed with status ${response.status}.`,
  });
});

const executePost = Effect.fn("j5.artifacts.client.executePost")(function* (input: {
  readonly prepared: PreparedConnection;
  readonly pathname: string;
  readonly body: unknown;
}) {
  const client = yield* HttpClient.HttpClient;
  const url = environmentEndpointUrl(input.prepared.httpBaseUrl, input.pathname);
  const request = yield* HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJson(input.body));
  const authorization = input.prepared.httpAuthorization;
  let authorizedRequest = request;
  if (authorization?._tag === "Bearer") {
    authorizedRequest = HttpClientRequest.bearerToken(request, authorization.token);
  } else if (authorization?._tag === "Dpop") {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            new ArtifactHttpError({
              status: 0,
              detail: "Artifact request could not be authorized.",
            }),
          onSome: Effect.succeed,
        }),
      ),
    );
    const dpop = yield* signer
      .createProof({ method: "POST", url, accessToken: authorization.accessToken })
      .pipe(
        Effect.mapError(
          () =>
            new ArtifactHttpError({
              status: 0,
              detail: "Artifact request could not be authorized.",
            }),
        ),
      );
    authorizedRequest = HttpClientRequest.setHeaders(request, {
      authorization: `DPoP ${authorization.accessToken}`,
      dpop,
    });
  }
  return yield* authorization === null
    ? client
        .execute(authorizedRequest)
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }))
    : client.execute(authorizedRequest);
});

const withPreparedConnection = <A, E>(
  environmentId: EnvironmentId,
  run: (
    prepared: PreparedConnection,
  ) => Effect.Effect<A, E, HttpClient.HttpClient | ManagedRelay.ManagedRelayDpopSigner>,
) => {
  const prepared = readPreparedConnection(environmentId);
  return prepared === null
    ? Effect.fail(
        new ArtifactHttpError({
          status: 0,
          detail: "The project environment is not connected.",
        }),
      )
    : run(prepared);
};

export const listArtifactsEffect = Effect.fn("j5.artifacts.client.list")(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const response = yield* withPreparedConnection(input.environmentId, (prepared) =>
    executePost({
      prepared,
      pathname: ARTIFACT_LIST_PATH,
      body: { projectId: input.projectId },
    }),
  );
  const success = yield* requireSuccess(response);
  const decoded = yield* HttpClientResponse.schemaBodyJson(ArtifactListResponse)(success);
  return decoded.entries;
});

export const readArtifactEffect = Effect.fn("j5.artifacts.client.read")(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly path: string;
}) {
  const response = yield* withPreparedConnection(input.environmentId, (prepared) =>
    executePost({
      prepared,
      pathname: ARTIFACT_READ_PATH,
      body: { projectId: input.projectId, path: input.path },
    }),
  );
  const success = yield* requireSuccess(response);
  return yield* HttpClientResponse.schemaBodyJson(ArtifactContent)(success);
});

export const listArtifacts = (input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): Promise<ReadonlyArray<ArtifactEntry>> => runtime.runPromise(listArtifactsEffect(input));

export const readArtifact = (input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly path: string;
}): Promise<ArtifactContentValue> => runtime.runPromise(readArtifactEffect(input));
