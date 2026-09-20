import {
  AuthA2APeerScope,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import {
  AddPeerRequest,
  IssuePeerCredentialRequest,
  J5_PEER_API_PATHS,
  RemovePeerRequest,
  peerSubjectForEnvironment,
  type AddPeerResponse,
  type IssuePeerCredentialResponse,
  type PeerHelloResponse,
  type PeerListResponse,
  type RemovePeerResponse,
} from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import packageJson from "../../../package.json" with { type: "json" };
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { PeerRegistryService } from "./PeerRegistryService.ts";

/**
 * The peering HTTP surface. Administrative routes (issue a credential, add,
 * list, remove) carry the same `access:*` scopes as Settings → Connections,
 * because a peer is one more authorized session there. The hello route is the
 * one thing a peer credential can reach in this PR: it proves reachability and
 * tells the caller who this server is and whom the credential names.
 */

const decodeIssueRequest = Schema.decodeUnknownEffect(IssuePeerCredentialRequest);
const decodeAddRequest = Schema.decodeUnknownEffect(AddPeerRequest);
const decodeRemoveRequest = Schema.decodeUnknownEffect(RemovePeerRequest);

const authenticate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  return yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
});

const requireScope = (
  session: EnvironmentAuth.AuthenticatedSession,
  scope: AuthEnvironmentScope,
) => (session.scopes.includes(scope) ? Effect.void : failEnvironmentScopeRequired(scope));

const jsonError = (
  status: number,
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
) => HttpServerResponse.jsonUnsafe({ error, message, ...extra }, { status });

const requestFailure = (message: string) => jsonError(400, "invalid_request", message);

const tagOf = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "Error";
const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const addFailure = (error: unknown): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  const tag = tagOf(error);
  const message = messageOf(error, "Adding the peer failed.");
  switch (tag) {
    case "PeerUnreachableError":
      return Effect.succeed(jsonError(502, "peer_unreachable", message));
    case "PeerCredentialRejectedError":
      return Effect.succeed(jsonError(502, "peer_credential_rejected", message));
    case "PeerCredentialMismatchError":
      return Effect.succeed(jsonError(409, "peer_credential_mismatch", message));
    case "PeerIsSelfError":
      return Effect.succeed(jsonError(400, "peer_is_self", message));
    default:
      return Effect.logError("J5 A2A peer add failed", { cause: error }).pipe(
        Effect.as(jsonError(500, tag, "Adding the peer failed.")),
      );
  }
};

const respondableTags = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

const readJsonBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* Effect.result(request.json);
});

export const peerHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const peers = yield* PeerRegistryService;
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

    // Rotation is list-revoke-issue; two concurrent issues could both revoke and
    // both issue, leaving two live credentials. One permit keeps rotation and
    // removal serial so exactly one session per peer subject survives.
    const rotationPermit = yield* Semaphore.make(1);

    /** One live session per peer subject: issuing again rotates the old one out. */
    const revokeSessionsForSubject = (subject: string) =>
      Effect.gen(function* () {
        const sessions = yield* serverAuth.listSessions();
        let revoked = 0;
        for (const session of sessions) {
          if (session.subject !== subject) continue;
          if (yield* serverAuth.revokeSession(session.sessionId)) revoked += 1;
        }
        return revoked;
      });

    const helloRoute = HttpRouter.add(
      "GET",
      J5_PEER_API_PATHS.hello,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.hello");
        const session = yield* authenticate;
        yield* requireScope(session, AuthA2APeerScope);
        const environmentId = yield* identity.getEnvironmentId;
        return HttpServerResponse.jsonUnsafe({
          environmentId,
          subject: session.subject,
          server: { version: packageJson.version },
        } satisfies PeerHelloResponse);
      }).pipe(Effect.catchTags(respondableTags)),
    );

    const issueCredentialRoute = HttpRouter.add(
      "POST",
      J5_PEER_API_PATHS.credentials,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.issueCredential");
        const session = yield* authenticate;
        yield* requireScope(session, AuthAccessWriteScope);
        const body = yield* readJsonBody;
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeIssueRequest(body.success));
        if (Result.isFailure(decoded)) {
          return requestFailure(
            "environmentId (the peer that will hold the credential) is required.",
          );
        }
        const ourEnvironmentId = yield* identity.getEnvironmentId;
        if (decoded.success.environmentId === ourEnvironmentId) {
          return jsonError(
            400,
            "peer_is_self",
            `Environment ${ourEnvironmentId} is this server; a server cannot peer with itself.`,
          );
        }
        const subject = peerSubjectForEnvironment(decoded.success.environmentId);
        const label = decoded.success.label?.trim() || decoded.success.environmentId;
        const issued = yield* Effect.result(
          rotationPermit.withPermit(
            revokeSessionsForSubject(subject).pipe(
              Effect.andThen(
                serverAuth.issueSession({
                  scopes: [AuthA2APeerScope],
                  subject,
                  label: `Peer: ${label}`,
                }),
              ),
            ),
          ),
        );
        if (Result.isFailure(issued)) {
          yield* Effect.logError("J5 A2A peer credential issuance failed", {
            cause: issued.failure,
          });
          return jsonError(500, tagOf(issued.failure), "Issuing the peer credential failed.");
        }
        return HttpServerResponse.jsonUnsafe(
          {
            environmentId: ourEnvironmentId,
            credential: issued.success.token,
            sessionId: issued.success.sessionId,
            subject,
            expiresAt: DateTime.formatIso(issued.success.expiresAt),
          } satisfies IssuePeerCredentialResponse,
          { status: 201 },
        );
      }).pipe(Effect.catchTags(respondableTags)),
    );

    const addRoute = HttpRouter.add(
      "POST",
      J5_PEER_API_PATHS.peers,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.add");
        const session = yield* authenticate;
        yield* requireScope(session, AuthAccessWriteScope);
        const body = yield* readJsonBody;
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeAddRequest(body.success));
        if (Result.isFailure(decoded)) {
          return requestFailure(
            "origin (an http(s) origin with no path) and the credential that server issued are required.",
          );
        }
        const acceptedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const added = yield* Effect.result(
          peers.add({
            origin: decoded.success.origin,
            credential: decoded.success.credential,
            label: decoded.success.label,
            acceptedAt,
          }),
        );
        if (Result.isFailure(added)) return yield* addFailure(added.failure);
        return HttpServerResponse.jsonUnsafe(
          { peer: added.success.peer, created: added.success.created } satisfies AddPeerResponse,
          { status: added.success.created ? 201 : 200 },
        );
      }).pipe(Effect.catchTags(respondableTags)),
    );

    const listRoute = HttpRouter.add(
      "GET",
      J5_PEER_API_PATHS.peers,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.list");
        const session = yield* authenticate;
        yield* requireScope(session, AuthAccessReadScope);
        const listed = yield* Effect.result(peers.list());
        if (Result.isFailure(listed)) {
          yield* Effect.logError("J5 A2A peer list failed", { cause: listed.failure });
          return jsonError(500, tagOf(listed.failure), "Listing peers failed.");
        }
        return HttpServerResponse.jsonUnsafe({ peers: listed.success } satisfies PeerListResponse);
      }).pipe(Effect.catchTags(respondableTags)),
    );

    const removeRoute = HttpRouter.add(
      "POST",
      J5_PEER_API_PATHS.remove,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.remove");
        const session = yield* authenticate;
        yield* requireScope(session, AuthAccessWriteScope);
        const body = yield* readJsonBody;
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeRemoveRequest(body.success));
        if (Result.isFailure(decoded)) return requestFailure("environmentId is required.");
        // Both directions end here: our record of the peer, and the session it held for us.
        const outcome = yield* Effect.result(
          rotationPermit.withPermit(
            Effect.all({
              removed: peers.remove(decoded.success.environmentId),
              revokedSessions: revokeSessionsForSubject(
                peerSubjectForEnvironment(decoded.success.environmentId),
              ),
            }),
          ),
        );
        if (Result.isFailure(outcome)) {
          yield* Effect.logError("J5 A2A peer remove failed", { cause: outcome.failure });
          return jsonError(500, tagOf(outcome.failure), "Removing the peer failed.");
        }
        return HttpServerResponse.jsonUnsafe({
          removed: outcome.success.removed.removed,
          revokedSessions: outcome.success.revokedSessions,
        } satisfies RemovePeerResponse);
      }).pipe(Effect.catchTags(respondableTags)),
    );

    return Layer.mergeAll(helloRoute, issueCredentialRoute, addRoute, listRoute, removeRoute);
  }),
);
