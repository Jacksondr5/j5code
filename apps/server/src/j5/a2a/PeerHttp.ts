import { AuthA2APeerScope, AuthAccessReadScope, AuthAccessWriteScope } from "@t3tools/contracts";
import {
  AddPeerRequest,
  IssuePeerCredentialRequest,
  J5_PEER_API_PATHS,
  PeerDeliveryRequest,
  RemovePeerRequest,
  environmentIdFromPeerSubject,
  peerSubjectForEnvironment,
  type AddPeerResponse,
  type IssuePeerCredentialResponse,
  type PeerDeliveryResponse,
  type PeerHelloResponse,
  type PeerListResponse,
  type PeerRosterResponse,
  type RemovePeerResponse,
} from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../../package.json" with { type: "json" };
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { annotateEnvironmentRequest } from "../../auth/http.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { PeerInboundService } from "./PeerInboundService.ts";
import { PeerRegistryService } from "./PeerRegistryService.ts";
import { RosterService } from "./RosterService.ts";
import {
  authenticate,
  jsonError,
  messageOf,
  readJsonBody,
  requestFailure,
  requireScope,
  respondableTags,
  tagOf,
} from "./httpSupport.ts";

/**
 * The peering HTTP surface. Administrative routes (issue a credential, add,
 * list, remove) carry the same `access:*` scopes as Settings → Connections,
 * because a peer is one more authorized session there. A peer credential
 * reaches two routes: hello, which proves reachability, tells the caller who
 * this server is and whom the credential names, and completes a rotation;
 * roster, the agents a registered peer may address; and deliver, which accepts
 * one message from a registered peer and records it before delivering locally.
 */

/**
 * A peer session outlives ordinary client sessions: nothing renews it, and a
 * silent thirty-day expiry would end peering with no one told. Ten years is
 * "until removed or rotated"; the expiry is recorded on the holder's peer
 * record and shown in Settings, so it is never a surprise.
 */
export const PEER_SESSION_TTL = Duration.days(3650);

const decodeIssueRequest = Schema.decodeUnknownEffect(IssuePeerCredentialRequest);
const decodeAddRequest = Schema.decodeUnknownEffect(AddPeerRequest);
const decodeRemoveRequest = Schema.decodeUnknownEffect(RemovePeerRequest);
const decodeDeliveryRequest = Schema.decodeUnknownEffect(PeerDeliveryRequest);

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
    case "PeerOriginConflictError":
      return Effect.succeed(jsonError(409, "peer_origin_conflict", message));
    case "PeerIsSelfError":
      return Effect.succeed(jsonError(400, "peer_is_self", message));
    default:
      return Effect.logError("J5 A2A peer add failed", { cause: error }).pipe(
        Effect.as(jsonError(500, tag, "Adding the peer failed.")),
      );
  }
};

const deliveryFailure = (error: unknown): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  const tag = tagOf(error);
  const message = messageOf(error, "Delivery failed.");
  switch (tag) {
    case "A2APeerReceiverNotFoundError":
      return Effect.succeed(jsonError(404, "recipient_not_found", message));
    case "A2APeerReceiverNotDeliverableError":
    case "A2APeerSenderNotOwnedError":
      return Effect.succeed(jsonError(403, "policy_refused", message, { reason: tag }));
    case "A2APeerAskIntentRequiredError":
      return Effect.succeed(requestFailure(message));
    case "A2APeerSenderNotAllowedError":
      return Effect.succeed(jsonError(403, "policy_refused", message, { reason: tag }));
    case "CommCommandConflictError":
      return Effect.succeed(jsonError(409, "message_id_conflict", message));
    default:
      return Effect.logError("J5 A2A peer delivery failed", { cause: error }).pipe(
        Effect.as(jsonError(500, tag, "Delivery failed.")),
      );
  }
};

export const peerHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const peers = yield* PeerRegistryService;
    const inbound = yield* PeerInboundService;
    const worker = yield* A2ADeliveryWorker;
    const roster = yield* RosterService;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

    // Rotation and removal list sessions and then revoke; one permit keeps them
    // serial so concurrent calls cannot leave two live credentials or revoke a
    // credential that was just issued.
    const rotationPermit = yield* Semaphore.make(1);

    /** A credential alone is not enough: the environment it names must be a recorded peer. */
    const registeredPeerForSession = (session: EnvironmentAuth.AuthenticatedSession) =>
      Effect.gen(function* () {
        const environmentId = environmentIdFromPeerSubject(session.subject);
        if (environmentId === null) {
          return Result.fail(
            jsonError(
              403,
              "peer_subject_required",
              `This credential is not bound to a peer environment (subject "${session.subject}").`,
            ),
          );
        }
        const peer = yield* Effect.result(peers.get(environmentId));
        if (Result.isFailure(peer)) {
          yield* Effect.logError("J5 A2A peer lookup failed", { cause: peer.failure });
          return Result.fail(jsonError(500, tagOf(peer.failure), "Peer lookup failed."));
        }
        return peer.success !== null
          ? Result.succeed(environmentId)
          : Result.fail(
              jsonError(
                403,
                "peer_not_registered",
                `Environment ${environmentId} holds a credential but is not a recorded peer of this server. Record it with \`j5 a2a peer add\` here, or remove the stale credential in Settings → Connections.`,
              ),
            );
      });

    /**
     * Revoke every other session this peer subject holds. Issuing a credential
     * does not revoke the old one; the peer proving the new one at hello does,
     * so a rotation that fails between issue and record leaves the old
     * credential working instead of the peer locked out.
     */
    const revokeOtherSessionsForSubject = (subject: string, keep: string) =>
      Effect.gen(function* () {
        const sessions = yield* serverAuth.listSessions();
        let revoked = 0;
        for (const session of sessions) {
          if (session.subject !== subject || session.sessionId === keep) continue;
          if (yield* serverAuth.revokeSession(session.sessionId)) revoked += 1;
        }
        return revoked;
      });

    const revokeAllSessionsForSubject = (subject: string) =>
      revokeOtherSessionsForSubject(subject, "");

    const helloRoute = HttpRouter.add(
      "GET",
      J5_PEER_API_PATHS.hello,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.hello");
        const session = yield* authenticate;
        yield* requireScope(session, AuthA2APeerScope);
        const environmentId = yield* peers.selfEnvironmentId;
        // The peer holds this credential, so any earlier one for it is done.
        yield* rotationPermit
          .withPermit(revokeOtherSessionsForSubject(session.subject, session.sessionId))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("J5 A2A peer hello could not rotate older sessions", { cause }),
            ),
          );
        return HttpServerResponse.jsonUnsafe({
          environmentId,
          subject: session.subject,
          credentialExpiresAt:
            session.expiresAt === undefined ? null : DateTime.formatIso(session.expiresAt),
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
        const ourEnvironmentId = yield* peers.selfEnvironmentId;
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
            serverAuth.issueSession({
              scopes: [AuthA2APeerScope],
              subject,
              label: `Peer: ${label}`,
              ttl: PEER_SESSION_TTL,
            }),
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
            replaceOrigin: decoded.success.replaceOrigin ?? false,
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
              revokedSessions: revokeAllSessionsForSubject(
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

    const deliverRoute = HttpRouter.add(
      "POST",
      J5_PEER_API_PATHS.deliver,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.deliver");
        const session = yield* authenticate;
        yield* requireScope(session, AuthA2APeerScope);
        const origin = yield* registeredPeerForSession(session);
        if (Result.isFailure(origin)) return origin.failure;
        const body = yield* readJsonBody;
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeDeliveryRequest(body.success));
        if (Result.isFailure(decoded)) {
          return requestFailure(
            "messageId, senderId, receiverId, exchangeId, correlationId, exchangeRole, envelopeChannel, text, originSquadronId, and createdAt are required.",
          );
        }
        const received = yield* Effect.result(
          inbound.receive({ ...decoded.success, originEnvironmentId: origin.success }),
        );
        if (Result.isFailure(received)) return yield* deliveryFailure(received.failure);
        yield* worker.notify;
        return HttpServerResponse.jsonUnsafe(
          {
            accepted: true,
            receivedSeq: received.success.receivedSeq,
            replay: received.success.replay,
          } satisfies PeerDeliveryResponse,
          { status: received.success.replay ? 200 : 201 },
        );
      }).pipe(Effect.catchTags(respondableTags)),
    );

    // A peer resolves receivers here, and sees only what it could address:
    // agents by Squadron. People, machine participants and liveness stay home.
    const rosterRoute = HttpRouter.add(
      "GET",
      J5_PEER_API_PATHS.roster,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.roster");
        const session = yield* authenticate;
        yield* requireScope(session, AuthA2APeerScope);
        const origin = yield* registeredPeerForSession(session);
        if (Result.isFailure(origin)) return origin.failure;
        const listed = yield* Effect.result(roster.list());
        if (Result.isFailure(listed)) {
          yield* Effect.logError("J5 A2A peer roster read failed", { cause: listed.failure });
          return jsonError(500, tagOf(listed.failure), "Roster read failed.");
        }
        return HttpServerResponse.jsonUnsafe({
          agents: listed.success.flatMap((entry) =>
            entry.kind === "agent" &&
            entry.squadronId !== null &&
            entry.squadronName !== null &&
            entry.threadId !== null
              ? [
                  {
                    participantId: entry.participantId,
                    squadronId: entry.squadronId,
                    squadronName: entry.squadronName,
                    threadId: entry.threadId,
                    displayName: entry.displayName,
                    archived: entry.archived,
                    canReceiveMessage: entry.canReceiveMessage,
                  },
                ]
              : [],
          ),
        } satisfies PeerRosterResponse);
      }).pipe(Effect.catchTags(respondableTags)),
    );

    return Layer.mergeAll(
      helloRoute,
      rosterRoute,
      issueCredentialRoute,
      addRoute,
      listRoute,
      removeRoute,
      deliverRoute,
    );
  }),
);
