import { AuthA2APeerScope, AuthAccessReadScope, AuthAccessWriteScope } from "@t3tools/contracts";
import {
  AddPeerRequest,
  IssuePeerCredentialRequest,
  J5_PEER_API_PATHS,
  PEER_PROTOCOL_VERSION,
  PeerDeliveryRequest,
  PeerPollRequest,
  PeerProbeRequest,
  RemovePeerRequest,
  environmentIdFromPeerSubject,
  peerSubjectForEnvironment,
  type AddPeerResponse,
  type IssuePeerCredentialResponse,
  type PeerDeliveryResponse,
  type PeerHelloResponse,
  type PeerListResponse,
  type PeerAddressesResponse,
  type PeerPollResponse,
  type PeerProbeResponse,
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
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as NodeOS from "node:os";

import packageJson from "../../../package.json" with { type: "json" };
import { ServerConfig } from "../../config.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { annotateEnvironmentRequest } from "../../auth/http.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { PeerInboundService, peerDeliveryRefusal } from "./PeerInboundService.ts";
import { PeerRegistryService } from "./PeerRegistryService.ts";
import { PeerRemovalService } from "./PeerRemovalService.ts";
import { PeerStoreService } from "./PeerStoreService.ts";
import { RosterService } from "./RosterService.ts";
import { peerAddressOrigins } from "./peerReachability.ts";
import { toPeerRoster } from "./peerRoster.ts";
import { peerProtocolHeaders, peerProtocolMismatch, statedPeerProtocol } from "./peerProtocol.ts";
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
const decodePollRequest = Schema.decodeUnknownEffect(PeerPollRequest);
const decodeProbeRequest = Schema.decodeUnknownEffect(PeerProbeRequest);

/** A peer on another protocol is refused before its request is read; the caller sees why in the 409. */
const protocolRefusal = (peer: string) =>
  Effect.map(HttpServerRequest.HttpServerRequest, (request) => {
    const reason = peerProtocolMismatch({ stated: statedPeerProtocol(request.headers), peer });
    return reason === null ? null : jsonError(409, "peer_protocol_mismatch", reason);
  });

/** Every answer on a peer route states this server's protocol, so the caller checks it too. */
const statingPeerProtocol = <E, R>(
  route: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => route.pipe(Effect.map(HttpServerResponse.setHeaders(peerProtocolHeaders)));

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
    case "PeerProtocolMismatchError":
      return Effect.succeed(jsonError(409, "peer_protocol_mismatch", message));
    case "PeerPollUnsupportedError":
      return Effect.succeed(jsonError(409, "peer_poll_unsupported", message));
    case "PeerLinkModeConflictError":
      return Effect.succeed(jsonError(409, "peer_link_mode_conflict", message));
    default:
      return Effect.logError("J5 A2A peer add failed", { cause: error }).pipe(
        Effect.as(jsonError(500, tag, "Adding the peer failed.")),
      );
  }
};

const deliveryFailure = (error: unknown): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  const refusal = peerDeliveryRefusal(error);
  if (refusal !== null) {
    return Effect.succeed(
      jsonError(
        refusal.status,
        refusal.code,
        refusal.message,
        refusal.reason === undefined ? {} : { reason: refusal.reason },
      ),
    );
  }
  return Effect.logError("J5 A2A peer delivery failed", { cause: error }).pipe(
    Effect.as(jsonError(500, tagOf(error), "Delivery failed.")),
  );
};

export const peerHttpRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const peers = yield* PeerRegistryService;
    const inbound = yield* PeerInboundService;
    const worker = yield* A2ADeliveryWorker;
    const roster = yield* RosterService;
    const store = yield* PeerStoreService;
    const removal = yield* PeerRemovalService;
    const config = yield* ServerConfig;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

    // Rotation and removal list sessions and then revoke; one permit keeps them
    // serial so concurrent calls cannot leave two live credentials or revoke a
    // credential that was just issued.
    const rotationPermit = yield* Semaphore.make(1);

    /** Whether the session's environment is a recorded peer, recording a store peer on its first proof. */
    const adoptingStorePeer = (
      session: EnvironmentAuth.AuthenticatedSession,
      environmentId: string,
    ) =>
      DateTime.now.pipe(
        Effect.flatMap((now) =>
          peers.adoptStorePeer({
            environmentId,
            sessionId: session.sessionId,
            at: DateTime.formatIso(now),
          }),
        ),
      );

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
        const peer = yield* Effect.result(adoptingStorePeer(session, environmentId));
        if (Result.isFailure(peer)) {
          yield* Effect.logError("J5 A2A peer lookup failed", { cause: peer.failure });
          return Result.fail(jsonError(500, tagOf(peer.failure), "Peer lookup failed."));
        }
        return peer.success
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
        const holder = environmentIdFromPeerSubject(session.subject);
        const refused = yield* protocolRefusal(`Peer ${holder ?? session.subject}`);
        if (refused !== null) return refused;
        // A poller's hello is the first proof of a store credential; it records the poller here.
        if (holder !== null) {
          yield* adoptingStorePeer(session, holder).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("J5 A2A peer hello could not record a polling peer", { cause }),
            ),
          );
        }
        const environmentId = yield* peers.selfEnvironmentId;
        const label = yield* peers.selfLabel;
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
          label,
          peerProtocolVersion: PEER_PROTOCOL_VERSION,
          capabilities: { poll: true },
        } satisfies PeerHelloResponse);
      }).pipe(Effect.catchTags(respondableTags), statingPeerProtocol),
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
        // A pair's way of travelling changes only by removing the peer and peering again.
        const store = decoded.success.store === true;
        const existing = yield* Effect.result(peers.get(decoded.success.environmentId));
        if (Result.isFailure(existing)) {
          yield* Effect.logError("J5 A2A peer lookup failed", { cause: existing.failure });
          return jsonError(500, tagOf(existing.failure), "Peer lookup failed.");
        }
        if (existing.success !== null && (existing.success.linkMode === "store") !== store) {
          return jsonError(
            409,
            "peer_link_mode_conflict",
            `Peer ${existing.success.label} is recorded here with link mode ${existing.success.linkMode}, so this server ${store ? "sends to it directly" : "stores its messages until it polls"}. To change how messages travel, remove the peer and peer again.`,
          );
        }
        const issuedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const issued = yield* Effect.result(
          rotationPermit.withPermit(
            serverAuth
              .issueSession({
                scopes: [AuthA2APeerScope],
                subject,
                label: `Peer: ${label}`,
                ttl: PEER_SESSION_TTL,
              })
              .pipe(
                // A store peer already recorded rotates as any peer does; only a new one needs the mark.
                Effect.tap((session) =>
                  store && existing.success === null
                    ? peers.grantStore({
                        environmentId: decoded.success.environmentId,
                        sessionId: session.sessionId,
                        issuedAt,
                      })
                    : Effect.void,
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
            linkMode: decoded.success.poll === true ? "poll" : "push",
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
        // Both directions end here: the session it held for us, first, so it
        // cannot deliver or poll during the wipe, then our record of the peer,
        // with everything still waiting on it.
        const outcome = yield* Effect.result(
          rotationPermit.withPermit(
            Effect.all({
              revokedSessions: revokeAllSessionsForSubject(
                peerSubjectForEnvironment(decoded.success.environmentId),
              ),
              removed: removal.remove(decoded.success.environmentId),
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
        const refused = yield* protocolRefusal(`Peer ${origin.success}`);
        if (refused !== null) return refused;
        const body = yield* readJsonBody;
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeDeliveryRequest(body.success));
        if (Result.isFailure(decoded)) {
          return requestFailure(
            "messageId, senderId, receiverId, exchangeId, correlationId, exchangeRole, envelopeChannel, text, originProjectId, and createdAt are required.",
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
      }).pipe(Effect.catchTags(respondableTags), statingPeerProtocol),
    );

    // A peer resolves receivers here, and sees only what it could address:
    // agents by project. People, machine participants and liveness stay home.
    const rosterRoute = HttpRouter.add(
      "GET",
      J5_PEER_API_PATHS.roster,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.roster");
        const session = yield* authenticate;
        yield* requireScope(session, AuthA2APeerScope);
        const origin = yield* registeredPeerForSession(session);
        if (Result.isFailure(origin)) return origin.failure;
        const refused = yield* protocolRefusal(`Peer ${origin.success}`);
        if (refused !== null) return refused;
        const listed = yield* Effect.result(roster.list());
        if (Result.isFailure(listed)) {
          yield* Effect.logError("J5 A2A peer roster read failed", { cause: listed.failure });
          return jsonError(500, tagOf(listed.failure), "Roster read failed.");
        }
        return HttpServerResponse.jsonUnsafe({
          label: yield* peers.selfLabel,
          agents: toPeerRoster(listed.success),
        } satisfies PeerRosterResponse);
      }).pipe(Effect.catchTags(respondableTags), statingPeerProtocol),
    );

    // The check before peering: where this server might be reached, and
    // whether this server can reach another at an origin. Nothing is recorded.
    const addressesRoute = HttpRouter.add(
      "GET",
      J5_PEER_API_PATHS.addresses,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.addresses");
        const session = yield* authenticate;
        yield* requireScope(session, AuthAccessWriteScope);
        return HttpServerResponse.jsonUnsafe({
          origins: peerAddressOrigins({
            host: config.host,
            port: config.port,
            interfaces: NodeOS.networkInterfaces(),
          }),
        } satisfies PeerAddressesResponse);
      }).pipe(Effect.catchTags(respondableTags)),
    );

    const probeRoute = HttpRouter.add(
      "POST",
      J5_PEER_API_PATHS.probe,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.probe");
        const session = yield* authenticate;
        yield* requireScope(session, AuthAccessWriteScope);
        const body = yield* readJsonBody;
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodeProbeRequest(body.success));
        if (Result.isFailure(decoded)) {
          return requestFailure("origin (an http(s) origin with no path) is required.");
        }
        return HttpServerResponse.jsonUnsafe(
          (yield* peers.probe(decoded.success.origin)) satisfies PeerProbeResponse,
        );
      }).pipe(Effect.catchTags(respondableTags)),
    );

    // A peer this server stores messages for asks for them here, acknowledging
    // what the last poll handed out; the request is held while nothing waits.
    const pollRoute = HttpRouter.add(
      "POST",
      J5_PEER_API_PATHS.poll,
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest("j5.a2a.peer.poll");
        const session = yield* authenticate;
        yield* requireScope(session, AuthA2APeerScope);
        // As at hello: a peer on another protocol is refused before anything is recorded for it.
        const refused = yield* protocolRefusal(
          `Peer ${environmentIdFromPeerSubject(session.subject) ?? session.subject}`,
        );
        if (refused !== null) return refused;
        const origin = yield* registeredPeerForSession(session);
        if (Result.isFailure(origin)) return origin.failure;
        const record = yield* Effect.result(peers.get(origin.success));
        if (Result.isFailure(record)) {
          yield* Effect.logError("J5 A2A peer lookup failed", { cause: record.failure });
          return jsonError(500, tagOf(record.failure), "Peer lookup failed.");
        }
        if (record.success?.linkMode !== "store") {
          return jsonError(
            409,
            "peer_not_polling",
            `Environment ${origin.success} is recorded here with link mode ${record.success?.linkMode ?? "none"}, so this server sends to it directly and stores nothing for it. To poll instead, remove the peer and peer again.`,
          );
        }
        const body = yield* readJsonBody;
        if (Result.isFailure(body)) return requestFailure("The request body must be JSON.");
        const decoded = yield* Effect.result(decodePollRequest(body.success));
        if (Result.isFailure(decoded)) {
          return requestFailure(
            "acks and rosterHash are required; roster, label and capabilities are optional.",
          );
        }
        const started = yield* Effect.result(
          store.startPoll({
            environmentId: origin.success,
            request: decoded.success,
            // The protocol check passed, so the poller runs this server's version.
            protocolVersion: PEER_PROTOCOL_VERSION,
          }),
        );
        if (Result.isFailure(started)) {
          yield* Effect.logError("J5 A2A peer poll failed", { cause: started.failure });
          return jsonError(500, tagOf(started.failure), "The poll failed.");
        }
        // The status and headers go out now and only the body is held, so the
        // poller can tell a held poll cut on the way from one never answered.
        // Node sends headers with the first body bytes, so the body opens with
        // whitespace JSON ignores.
        const answer = started.success.pipe(
          Effect.map((polled) => JSON.stringify(polled satisfies PeerPollResponse)),
          Effect.tapCause((cause) => Effect.logError("J5 A2A peer poll failed", { cause })),
        );
        return HttpServerResponse.stream(
          Stream.concat(Stream.make(" "), Stream.fromEffect(answer)).pipe(Stream.encodeText),
          { contentType: "application/json" },
        );
      }).pipe(Effect.catchTags(respondableTags), statingPeerProtocol),
    );

    return Layer.mergeAll(
      addressesRoute,
      probeRoute,
      pollRoute,
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
