import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { executeJ5Request } from "@t3tools/client-runtime/j5/http";
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
import * as Schema from "effect/Schema";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";

export class ArtifactHttpError extends Schema.TaggedErrorClass<ArtifactHttpError>()(
  "ArtifactHttpError",
  { status: Schema.Number, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const READ_TIMEOUT_MS = 10_000;

/**
 * Both artifact reads go through the shared J5 request helper, which resolves the credential at
 * request time (cookie, static bearer, or relay access token with a fresh DPoP proof) and refreshes
 * a rejected relay token once. A hand-rolled bearer/DPoP branch here signed with whatever token the
 * prepared connection held at page load, so on T3 Connect the change stream kept flowing while
 * every list and read returned 401 once that token expired.
 */
const post = Effect.fn("j5.artifacts.client.post")(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly pathname: string;
  readonly body: unknown;
}) {
  const prepared: PreparedConnection | null = readPreparedConnection(input.environmentId);
  if (prepared === null) {
    return yield* new ArtifactHttpError({
      status: 0,
      detail: "The project environment is not connected.",
    });
  }
  const request = yield* HttpClientRequest.post(input.pathname).pipe(
    HttpClientRequest.bodyJson(input.body),
  );
  return yield* executeJ5Request(prepared, request, READ_TIMEOUT_MS).pipe(
    Effect.mapError((error) =>
      error._tag === "J5HttpError"
        ? new ArtifactHttpError({ status: error.status, detail: error.detail })
        : new ArtifactHttpError({ status: 0, detail: String(error) }),
    ),
  );
});

export const listArtifactsEffect = Effect.fn("j5.artifacts.client.list")(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const response = yield* post({
    environmentId: input.environmentId,
    pathname: ARTIFACT_LIST_PATH,
    body: { projectId: input.projectId },
  });
  const decoded = yield* HttpClientResponse.schemaBodyJson(ArtifactListResponse)(response);
  return decoded.entries;
});

export const readArtifactEffect = Effect.fn("j5.artifacts.client.read")(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly path: string;
}) {
  const response = yield* post({
    environmentId: input.environmentId,
    pathname: ARTIFACT_READ_PATH,
    body: { projectId: input.projectId, path: input.path },
  });
  return yield* HttpClientResponse.schemaBodyJson(ArtifactContent)(response);
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
