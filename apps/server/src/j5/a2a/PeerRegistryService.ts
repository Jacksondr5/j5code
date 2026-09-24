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

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";

/**
 * The peer registry: the other servers this one exchanges agent messages
 * with. A peer is recorded only after this server has reached it at the
 * stated origin with the credential it issued to us and that credential named
 * us. The credential the peer holds for this server is an ordinary session in
 * the auth database; a record reports whether that session is still live, so
 * a revoked or expired peer shows as such instead of looking healthy.
 */

const PEER_HELLO_TIMEOUT = Duration.seconds(5);

export interface AddPeerInput {
  readonly origin: string;
  readonly credential: string;
  readonly label: string | undefined;
  /** Re-adding a known peer at a different origin is refused unless the caller says so. */
  readonly replaceOrigin: boolean;
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

/** Hello proves the origin is reachable, not that it is the same server; moving a peer is an explicit act. */
export class PeerOriginConflictError extends Schema.TaggedError<PeerOriginConflictError>()(
  "PeerOriginConflictError",
  { environmentId: Schema.String, recordedOrigin: Schema.String, requestedOrigin: Schema.String },
) {
  override get message(): string {
    return `Peer ${this.environmentId} is recorded at ${this.recordedOrigin}, not ${this.requestedOrigin}. Pass replaceOrigin (\`--replace-origin\`) to move it.`;
  }
}

export class PeerSessionReadError extends Schema.TaggedError<PeerSessionReadError>()(
  "PeerSessionReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the sessions peers hold on this server.";
  }
}

export type AddPeerError =
  | SqlError
  | PeerSessionReadError
  | PeerUnreachableError
  | PeerCredentialRejectedError
  | PeerCredentialMismatchError
  | PeerIsSelfError
  | PeerOriginConflictError;

export interface PeerRegistryServiceShape {
  /** Proves the credential at the origin, then upserts; re-adding the same peer rotates its credential. */
  readonly add: (
    input: AddPeerInput,
  ) => Effect.Effect<{ readonly peer: PeerRecord; readonly created: boolean }, AddPeerError>;
  readonly get: (
    environmentId: string,
  ) => Effect.Effect<PeerRecord | null, SqlError | PeerSessionReadError>;
  readonly list: () => Effect.Effect<ReadonlyArray<PeerRecord>, SqlError | PeerSessionReadError>;
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
  readonly credential_expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const decodeHello = Schema.decodeUnknownEffect(PeerHelloResponse);

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** GET the peer's hello with the credential it issued; the answer names the peer and whom the credential is for. */
const helloAtOrigin = Effect.fn("j5.a2a.peer.hello")(function* (input: {
  readonly origin: string;
  readonly credential: string;
}) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(`${input.origin}${J5_PEER_API_PATHS.hello}`).pipe(
    HttpClientRequest.bearerToken(input.credential),
    HttpClientRequest.acceptJson,
  );
  const response = yield* client
    .execute(request)
    .pipe(
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
  return yield* response.json.pipe(
    Effect.flatMap(decodeHello),
    Effect.mapError(
      (cause) =>
        new PeerUnreachableError({
          origin: input.origin,
          reason: `the hello route answered with an unexpected shape: ${reasonOf(cause)}`,
        }),
    ),
  );
});

/** The whole exchange is bounded: a peer that answers headers and then stalls the body cannot hold a request open. */
const helloAtOriginBounded = (input: { readonly origin: string; readonly credential: string }) =>
  helloAtOrigin(input).pipe(
    Effect.timeoutOrElse({
      duration: PEER_HELLO_TIMEOUT,
      orElse: () =>
        new PeerUnreachableError({
          origin: input.origin,
          reason: `no complete hello answer within ${Duration.format(PEER_HELLO_TIMEOUT)}`,
        }),
    }),
  );

export const layer: Layer.Layer<
  PeerRegistryService,
  never,
  | SqlClient.SqlClient
  | HttpClient.HttpClient
  | ServerEnvironment.ServerEnvironmentIdentity
  | EnvironmentAuth.EnvironmentAuth
> = Layer.effect(
  PeerRegistryService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const httpClient = yield* HttpClient.HttpClient;
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

    /** The subjects that currently hold a live session here; a peer without one cannot deliver to us. */
    const liveSubjects = serverAuth.listSessions().pipe(
      Effect.map((sessions) => new Set(sessions.map((session) => session.subject))),
      Effect.mapError((cause) => new PeerSessionReadError({ cause })),
    );

    const recordFromRow = (row: PeerRow, live: ReadonlySet<string>): PeerRecord => ({
      environmentId: row.environment_id,
      label: row.label,
      origin: row.origin,
      credentialExpiresAt: row.credential_expires_at,
      inboundSession: live.has(peerSubjectForEnvironment(row.environment_id))
        ? "active"
        : "missing",
      createdAt: row.created_at,
    });

    const readRow = Effect.fn("j5.a2a.peer.readRow")(function* (environmentId: string) {
      const rows = yield* sql<PeerRow>`
        SELECT environment_id, label, origin, credential_expires_at, created_at, updated_at
        FROM j5_a2a_peer
        WHERE environment_id = ${environmentId}
        LIMIT 1
      `;
      return rows[0] ?? null;
    });

    const add: PeerRegistryServiceShape["add"] = (input) =>
      Effect.gen(function* () {
        const ourEnvironmentId: EnvironmentId = yield* identity.getEnvironmentId;
        const hello = yield* helloAtOriginBounded({
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
        const existing = yield* readRow(hello.environmentId);
        if (existing !== null && existing.origin !== input.origin && !input.replaceOrigin) {
          return yield* new PeerOriginConflictError({
            environmentId: hello.environmentId,
            recordedOrigin: existing.origin,
            requestedOrigin: input.origin,
          });
        }
        const label = input.label?.trim() || hello.environmentId;
        const expiresAt = hello.credentialExpiresAt ?? null;
        // One statement records or rotates; created_at survives an update.
        const rows = yield* sql<PeerRow>`
          INSERT INTO j5_a2a_peer (environment_id, label, origin, credential, credential_expires_at, created_at, updated_at)
          VALUES (${hello.environmentId}, ${label}, ${input.origin}, ${input.credential}, ${expiresAt}, ${input.acceptedAt}, ${input.acceptedAt})
          ON CONFLICT(environment_id) DO UPDATE SET
            label = excluded.label,
            origin = excluded.origin,
            credential = excluded.credential,
            credential_expires_at = excluded.credential_expires_at,
            updated_at = excluded.updated_at
          RETURNING environment_id, label, origin, credential_expires_at, created_at, updated_at
        `;
        const row = rows[0]!;
        const live = yield* liveSubjects;
        return { peer: recordFromRow(row, live), created: existing === null };
      });

    const get: PeerRegistryServiceShape["get"] = (environmentId) =>
      Effect.gen(function* () {
        const row = yield* readRow(environmentId);
        if (row === null) return null;
        return recordFromRow(row, yield* liveSubjects);
      });

    const list: PeerRegistryServiceShape["list"] = () =>
      Effect.gen(function* () {
        const rows = yield* sql<PeerRow>`
          SELECT environment_id, label, origin, credential_expires_at, created_at, updated_at
          FROM j5_a2a_peer
          ORDER BY label, environment_id
        `;
        if (rows.length === 0) return [];
        const live = yield* liveSubjects;
        return rows.map((row) => recordFromRow(row, live));
      });

    const remove: PeerRegistryServiceShape["remove"] = (environmentId) =>
      sql<{ readonly environment_id: string }>`
        DELETE FROM j5_a2a_peer WHERE environment_id = ${environmentId}
        RETURNING environment_id
      `.pipe(Effect.map((rows) => ({ removed: rows.length > 0 })));

    return PeerRegistryService.of({ add, get, list, remove });
  }),
);
