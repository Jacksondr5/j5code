import type { EnvironmentId } from "@t3tools/contracts";
import {
  J5_PEER_API_PATHS,
  PeerHelloResponse,
  peerSubjectForEnvironment,
  type PeerRecord,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";

/**
 * The peer registry: the other servers this one exchanges agent messages
 * with. A peer is recorded only after this server has reached it at the
 * stated origin with the credential it issued to us and that credential named
 * us. The credential the peer holds for this server is an ordinary session in
 * the auth database, revoked by the route that removes the peer.
 */

export const PEER_HELLO_TIMEOUT = Duration.seconds(5);

export interface AddPeerInput {
  readonly origin: string;
  readonly credential: string;
  readonly label: string | undefined;
  readonly acceptedAt: string;
}

export class PeerUnreachableError extends Schema.TaggedError<PeerUnreachableError>()(
  "PeerUnreachableError",
  { origin: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Could not reach a J5 server at ${this.origin}: ${this.reason}. Confirm the origin this server can use; it may differ from the one your client uses.`;
  }
}

export class PeerCredentialRejectedError extends Schema.TaggedError<PeerCredentialRejectedError>()(
  "PeerCredentialRejectedError",
  { origin: Schema.String, status: Schema.Number },
) {
  override get message(): string {
    return `${this.origin} rejected the credential (HTTP ${String(this.status)}). Issue a fresh one there with the a2a:peer scope for this environment.`;
  }
}

export class PeerCredentialMismatchError extends Schema.TaggedError<PeerCredentialMismatchError>()(
  "PeerCredentialMismatchError",
  { origin: Schema.String, expectedSubject: Schema.String, actualSubject: Schema.String },
) {
  override get message(): string {
    return `The credential ${this.origin} accepted names ${this.actualSubject}, not this environment (${this.expectedSubject}). It was issued for a different server.`;
  }
}

export class PeerIsSelfError extends Schema.TaggedError<PeerIsSelfError>()("PeerIsSelfError", {
  origin: Schema.String,
  environmentId: Schema.String,
}) {
  override get message(): string {
    return `${this.origin} is this server (environment ${this.environmentId}); a server cannot peer with itself.`;
  }
}

export type AddPeerError =
  | SqlError
  | PeerUnreachableError
  | PeerCredentialRejectedError
  | PeerCredentialMismatchError
  | PeerIsSelfError;

export interface PeerRegistryServiceShape {
  /** Proves the credential at the origin, then upserts; re-adding the same peer rotates its origin and credential. */
  readonly add: (
    input: AddPeerInput,
  ) => Effect.Effect<{ readonly peer: PeerRecord; readonly created: boolean }, AddPeerError>;
  readonly list: () => Effect.Effect<ReadonlyArray<PeerRecord>, SqlError>;
  readonly remove: (
    environmentId: string,
  ) => Effect.Effect<{ readonly removed: boolean }, SqlError>;
}

export class PeerRegistryService extends Context.Service<
  PeerRegistryService,
  PeerRegistryServiceShape
>()("t3/j5/a2a/PeerRegistryService") {}

interface PeerRow {
  readonly environment_id: string;
  readonly label: string;
  readonly origin: string;
  readonly created_at: string;
}

const recordFromRow = (row: PeerRow): PeerRecord => ({
  environmentId: row.environment_id,
  label: row.label,
  origin: row.origin,
  createdAt: row.created_at,
});

const decodeHello = Schema.decodeUnknownEffect(PeerHelloResponse);

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** GET the peer's hello with the credential it issued; the answer names the peer and whom the credential is for. */
export const helloAtOrigin = Effect.fn("j5.a2a.peer.hello")(function* (input: {
  readonly origin: string;
  readonly credential: string;
}) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(`${input.origin}${J5_PEER_API_PATHS.hello}`).pipe(
    HttpClientRequest.bearerToken(input.credential),
    HttpClientRequest.acceptJson,
  );
  const response = yield* client.execute(request).pipe(
    Effect.timeout(PEER_HELLO_TIMEOUT),
    Effect.mapError(
      (cause) => new PeerUnreachableError({ origin: input.origin, reason: reasonOf(cause) }),
    ),
  );
  if (response.status === 401 || response.status === 403) {
    return yield* new PeerCredentialRejectedError({
      origin: input.origin,
      status: response.status,
    });
  }
  if (response.status !== 200) {
    return yield* new PeerUnreachableError({
      origin: input.origin,
      reason: `the hello route answered HTTP ${String(response.status)}`,
    });
  }
  const body = yield* response.json.pipe(
    Effect.flatMap(decodeHello),
    Effect.mapError(
      (cause) =>
        new PeerUnreachableError({
          origin: input.origin,
          reason: `the hello route answered with an unexpected shape: ${reasonOf(cause)}`,
        }),
    ),
  );
  return body;
});

export const layer: Layer.Layer<
  PeerRegistryService,
  never,
  SqlClient.SqlClient | HttpClient.HttpClient | ServerEnvironment.ServerEnvironmentIdentity
> = Layer.effect(
  PeerRegistryService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const httpClient = yield* HttpClient.HttpClient;
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;

    const readRow = Effect.fn("j5.a2a.peer.readRow")(function* (environmentId: string) {
      const rows = yield* sql<PeerRow>`
        SELECT environment_id, label, origin, created_at
        FROM j5_a2a_peer
        WHERE environment_id = ${environmentId}
        LIMIT 1
      `;
      return rows[0] === undefined ? null : recordFromRow(rows[0]);
    });

    const add: PeerRegistryServiceShape["add"] = (input) =>
      Effect.gen(function* () {
        const ourEnvironmentId: EnvironmentId = yield* identity.getEnvironmentId;
        const hello = yield* helloAtOrigin({
          origin: input.origin,
          credential: input.credential,
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
        if (hello.environmentId === ourEnvironmentId) {
          return yield* new PeerIsSelfError({
            origin: input.origin,
            environmentId: ourEnvironmentId,
          });
        }
        const expectedSubject = peerSubjectForEnvironment(ourEnvironmentId);
        if (hello.subject !== expectedSubject) {
          return yield* new PeerCredentialMismatchError({
            origin: input.origin,
            expectedSubject,
            actualSubject: hello.subject,
          });
        }
        const label = input.label?.trim() || hello.environmentId;
        const existing = yield* readRow(hello.environmentId);
        if (existing === null) {
          yield* sql`
            INSERT INTO j5_a2a_peer (environment_id, label, origin, credential, created_at, updated_at)
            VALUES (${hello.environmentId}, ${label}, ${input.origin}, ${input.credential}, ${input.acceptedAt}, ${input.acceptedAt})
          `;
        } else {
          yield* sql`
            UPDATE j5_a2a_peer
            SET label = ${label}, origin = ${input.origin}, credential = ${input.credential}, updated_at = ${input.acceptedAt}
            WHERE environment_id = ${hello.environmentId}
          `;
        }
        const peer = yield* readRow(hello.environmentId);
        return {
          peer: peer ?? {
            environmentId: hello.environmentId,
            label,
            origin: input.origin,
            createdAt: input.acceptedAt,
          },
          created: existing === null,
        };
      });

    const list: PeerRegistryServiceShape["list"] = () =>
      sql<PeerRow>`
        SELECT environment_id, label, origin, created_at
        FROM j5_a2a_peer
        ORDER BY label, environment_id
      `.pipe(Effect.map((rows) => rows.map(recordFromRow)));

    const remove: PeerRegistryServiceShape["remove"] = (environmentId) =>
      Effect.gen(function* () {
        const existing = yield* readRow(environmentId);
        if (existing === null) return { removed: false };
        yield* sql`DELETE FROM j5_a2a_peer WHERE environment_id = ${environmentId}`;
        return { removed: true };
      });

    return PeerRegistryService.of({ add, list, remove });
  }),
);
