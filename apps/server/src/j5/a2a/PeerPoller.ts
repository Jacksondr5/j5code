import {
  J5_PEER_API_PATHS,
  PeerPollResponse,
  type PeerPollAck,
  type PeerPollRequest,
} from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";

import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { A2ADeliveryWorker } from "./DeliveryWorker.ts";
import { A2ALedger } from "./LedgerService.ts";
import { PeerInboundService, peerDeliveryRefusal } from "./PeerInboundService.ts";
import { PeerRegistryService } from "./PeerRegistryService.ts";
import { PEER_POLL_HOLD } from "./PeerStoreService.ts";
import { RosterService } from "./RosterService.ts";
import { peerProtocolHeaders, peerProtocolMismatch, statedPeerProtocol } from "./peerProtocol.ts";
import { peerRosterHash, toPeerRoster } from "./peerRoster.ts";

/**
 * The polling side of poll mode. This server cannot be reached by a peer, so
 * for each peer recorded with link mode `poll` it runs one loop that asks the
 * peer for the messages it stores here. Each poll acknowledges the previous
 * batch, sends this server's roster when it changed, and records each delivery
 * through the inbound service exactly as the deliver route does, one at a time
 * and in order. Messages this server sends to the peer still go directly.
 *
 * The loop is the heartbeat: a held poll answers within the hold, so a poll
 * completes at least that often while the server runs. A roster change
 * abandons the poll in flight, so the peer learns of an archive or a rename at
 * once.
 */

/**
 * The storing server answers a poll's status and headers at once and holds
 * only the body. A poll without headers within this margin was not answered,
 * and a body still open past the hold plus this margin has been lost, such as
 * across a sleep.
 */
const POLL_REQUEST_MARGIN = Duration.seconds(15);
/** How long a refusal's body may take to word its reason; the headers already decided. */
const REFUSAL_REASON_TIMEOUT = Duration.seconds(2);
const BACKOFF_START = Duration.seconds(1);
/** A cut poll is retried after this fixed pause, so a proxy that cuts every poll at once cannot spin the loop. */
const CUT_RETRY = Duration.seconds(1);
const BACKOFF_CAP = Duration.minutes(1);

export type PeerPollOutcome =
  | { readonly kind: "polled"; readonly received: number; readonly more: boolean }
  /** The roster changed while the request was held; poll again at once with the new one. */
  | { readonly kind: "abandoned" }
  /** A held body cut on the way, or lost across a sleep: not an error; poll again after a fixed second. */
  | { readonly kind: "cut" }
  /** Not answered, or an error answer: back off and try again. */
  | { readonly kind: "failed"; readonly reason: string }
  /** Only re-pairing or an update fixes it, so polling stops until the peer is recorded again. */
  | { readonly kind: "stopped"; readonly reason: string };

export interface PeerPollerShape {
  /** One poll of one peer. `abandon` ends a held request early. The loop runs it; tests drive it. */
  readonly pollOnce: (
    environmentId: string,
    abandon?: Effect.Effect<void>,
  ) => Effect.Effect<PeerPollOutcome>;
}

export class PeerPoller extends Context.Service<PeerPoller, PeerPollerShape>()(
  "t3/j5/a2a/PeerPoller",
) {}

interface PollState {
  /**
   * The peer record this state belongs to, by when it was recorded. A peer
   * removed and recorded again starts empty; a credential rotated in the same
   * mode keeps its record, and so its state.
   */
  readonly peerCreatedAt: string;
  /** The previous batch's outcomes, sent with the next poll and cleared once it is answered. */
  readonly acks: ReadonlyArray<PeerPollAck>;
  /** The roster snapshot the storing server holds for this server, as its hash. */
  readonly heldRosterHash: string | null;
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodePollResponse = Schema.decodeUnknownEffect(PeerPollResponse);

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * How the storing server took a poll, told by what had arrived when it ended:
 * nothing, a refusal's headers, a 200's headers and then nothing more, or a
 * whole answer.
 */
type PollExchange =
  | { readonly kind: "unanswered"; readonly cause: unknown }
  | { readonly kind: "refused"; readonly response: HttpClientResponse.HttpClientResponse }
  | { readonly kind: "cut" }
  | {
      readonly kind: "answered";
      readonly response: HttpClientResponse.HttpClientResponse;
      readonly body: string;
    };

const make = (daemon: boolean) =>
  Effect.gen(function* () {
    const peers = yield* PeerRegistryService;
    const inbound = yield* PeerInboundService;
    const worker = yield* A2ADeliveryWorker;
    const roster = yield* RosterService;
    const ledger = yield* A2ALedger;
    const threadEvents = yield* EventSinkV2;
    const httpClient = yield* HttpClient.HttpClient;
    const states = yield* Ref.make(new Map<string, PollState>());

    const stateOf = (environmentId: string) =>
      Ref.get(states).pipe(Effect.map((map) => map.get(environmentId)));
    const setState = (environmentId: string, state: PollState) =>
      Ref.update(states, (map) => new Map(map).set(environmentId, state));

    /** Each delivery is recorded as the deliver route records it; the outcome is its ack. */
    const receiveBatch = Effect.fn("j5.a2a.peer.poller.receive")(function* (
      environmentId: string,
      response: PeerPollResponse,
    ) {
      const acks: Array<PeerPollAck> = [];
      for (const delivery of response.deliveries) {
        const received = yield* Effect.exit(
          inbound.receive({ ...delivery, originEnvironmentId: environmentId }),
        );
        if (Exit.isSuccess(received)) {
          acks.push({
            messageId: delivery.messageId,
            outcome: "received",
            receivedSeq: received.value.receivedSeq,
            replay: received.value.replay,
          });
          continue;
        }
        const failure = Cause.findErrorOption(received.cause);
        const refusal = Option.isSome(failure) ? peerDeliveryRefusal(failure.value) : null;
        if (refusal === null) {
          // Not a refusal: leave this and every later one unacknowledged, in
          // order, so the next poll hands them out again.
          yield* Effect.logWarning("J5 A2A polled delivery could not be recorded", {
            cause: received.cause,
          });
          break;
        }
        acks.push({
          messageId: delivery.messageId,
          outcome: "refused",
          code: refusal.code,
          message: refusal.message.slice(0, 4_000),
        });
      }
      if (acks.some((ack) => ack.outcome === "received")) yield* worker.notify;
      return acks;
    });

    /** One poll; `abandon` is given the roster hash this poll sent. */
    const poll = (
      environmentId: string,
      abandon: (sentRosterHash: string) => Effect.Effect<void>,
    ): Effect.Effect<PeerPollOutcome> =>
      Effect.gen(function* () {
        const peer = yield* peers.connection(environmentId);
        if (
          peer === null ||
          peer.linkMode !== "poll" ||
          peer.origin === null ||
          peer.credential === null
        ) {
          return { kind: "stopped", reason: "the peer is no longer polled" } as const;
        }
        const stored = yield* stateOf(environmentId);
        const state =
          stored?.peerCreatedAt === peer.createdAt ? stored : { acks: [], heldRosterHash: null };
        const agents = toPeerRoster(yield* roster.list());
        const rosterHash = peerRosterHash(agents);
        const body = {
          acks: state.acks,
          rosterHash,
          label: yield* peers.selfLabel,
          capabilities: { poll: true },
          ...(rosterHash === state.heldRosterHash ? {} : { roster: agents }),
        } satisfies PeerPollRequest;
        const request = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(`${peer.origin}${J5_PEER_API_PATHS.poll}`).pipe(
            HttpClientRequest.bearerToken(peer.credential),
            HttpClientRequest.acceptJson,
            HttpClientRequest.setHeaders(peerProtocolHeaders),
          ),
          body,
        );
        const exchange = Effect.gen(function* () {
          const headed = yield* httpClient
            .execute(request)
            .pipe(Effect.timeout(POLL_REQUEST_MARGIN), Effect.result);
          if (headed._tag === "Failure") {
            return { kind: "unanswered", cause: headed.failure } satisfies PollExchange;
          }
          const response = headed.success;
          const mismatch = peerProtocolMismatch({
            stated: statedPeerProtocol(response.headers),
            peer: peer.label,
          });
          if (mismatch !== null || response.status !== 200) {
            return { kind: "refused", response } satisfies PollExchange;
          }
          // A 200's headers answer the poll: the heartbeat. Only the body is held.
          yield* peers.recordPolled(environmentId, DateTime.formatIso(yield* DateTime.now));
          const body = yield* Effect.result(response.text);
          if (body._tag === "Failure") return { kind: "cut" } satisfies PollExchange;
          return { kind: "answered", response, body: body.success } satisfies PollExchange;
        });
        // One bound for the whole held request: past the hold and its margin it
        // was lost, such as across a sleep, and the headers phase ends sooner.
        // A roster change abandons it in either phase.
        const exchanged = yield* exchange.pipe(
          Effect.timeoutOption(Duration.sum(PEER_POLL_HOLD, POLL_REQUEST_MARGIN)),
          Effect.map(Option.getOrElse((): PollExchange => ({ kind: "cut" }))),
          Effect.raceFirst(abandon(rosterHash).pipe(Effect.as({ kind: "abandoned" } as const))),
        );
        if (exchanged.kind === "abandoned") return { kind: "abandoned" } as const;
        if (exchanged.kind === "cut") return { kind: "cut" } as const;
        if (exchanged.kind === "unanswered") {
          const reason = `could not reach ${peer.label}: ${reasonOf(exchanged.cause)}`;
          yield* peers.recordLastError(environmentId, reason);
          return { kind: "failed", reason } as const;
        }
        const stop = (reason: string) =>
          peers
            .recordLastError(environmentId, reason)
            .pipe(Effect.as({ kind: "stopped", reason } as const));
        if (exchanged.kind === "refused") {
          // The headers decide. The body only words the reason, briefly, so one
          // that stalls cannot hold up stopping or backing off.
          const response = exchanged.response;
          const mismatch = peerProtocolMismatch({
            stated: statedPeerProtocol(response.headers),
            peer: peer.label,
          });
          if (mismatch !== null) return yield* stop(mismatch);
          if (response.status === 401) {
            return yield* stop(
              `${peer.label} rejected this server's credential (HTTP 401). Peer again to issue a new one.`,
            );
          }
          const message = yield* response.json.pipe(
            Effect.map((json) =>
              typeof json === "object" && json !== null && "message" in json
                ? String(json.message)
                : null,
            ),
            Effect.timeoutOption(REFUSAL_REASON_TIMEOUT),
            Effect.map(Option.getOrNull),
            Effect.orElseSucceed(() => null),
          );
          if (response.status === 403 || response.status === 409) {
            return yield* stop(
              message ??
                `${peer.label} refused the poll (HTTP ${String(response.status)}), so polling stopped until the two servers are peered again.`,
            );
          }
          const reason = `${peer.label} answered the poll with HTTP ${String(response.status)}${message === null ? "" : `: ${message}`}`;
          yield* peers.recordLastError(environmentId, reason);
          return { kind: "failed", reason } as const;
        }
        const { response } = exchanged;
        // A body that arrived whole but is not an answer is an error, not a cut.
        const json = yield* Effect.result(decodeJson(exchanged.body));
        if (json._tag === "Failure") {
          const reason = `${peer.label} answered the poll with a body that is not JSON: ${reasonOf(json.failure)}`;
          yield* peers.recordLastError(environmentId, reason);
          return { kind: "failed", reason } as const;
        }
        const decoded = yield* Effect.result(decodePollResponse(json.success));
        if (decoded._tag === "Failure") {
          const reason = `${peer.label} answered the poll with an unexpected shape: ${reasonOf(decoded.failure)}`;
          yield* peers.recordLastError(environmentId, reason);
          return { kind: "failed", reason } as const;
        }
        const polled = decoded.success;
        // The storing server's own name and capabilities.
        yield* peers.recordPoll({
          environmentId,
          receivedAt: DateTime.formatIso(yield* DateTime.now),
          protocolVersion: Number(statedPeerProtocol(response.headers) ?? "1"),
          label: polled.label,
          capabilities: polled.capabilities,
          roster: undefined,
        });
        const acks = yield* receiveBatch(environmentId, polled);
        yield* setState(environmentId, {
          peerCreatedAt: peer.createdAt,
          acks,
          heldRosterHash: polled.rosterHash,
        });
        return { kind: "polled", received: polled.deliveries.length, more: polled.more } as const;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("J5 A2A peer poll failed", { cause }).pipe(
            Effect.as({ kind: "failed", reason: "the poll failed on this server" } as const),
          ),
        ),
        Effect.withSpan("j5.a2a.peer.poller.pollOnce"),
      );

    const pollOnce: PeerPollerShape["pollOnce"] = (environmentId, abandon = Effect.never) =>
      poll(environmentId, () => abandon);

    /**
     * The next change to the roster this server sends, once the poll that sent
     * `sentRosterHash` is held. The roster changes when an agent joins, leaves
     * or is archived, a ledger fact, or when its thread is renamed, a thread
     * metadata update. Either only prompts a fresh reading of the roster, so an
     * update that leaves it as sent, such as a branch change, is not a change.
     * Both sources are listened to from before the roster is read: the ledger
     * subscription is held from here, and thread updates replay from the
     * sequence read here. Renaming a Squadron also changes the roster, but it
     * writes no event, so the new name goes out with the next poll, within
     * the hold.
     */
    const nextRosterChange = Effect.gen(function* () {
      const committed = yield* ledger.subscribeCommitted;
      const afterSequence = yield* Effect.option(threadEvents.latestSequence());
      const renames = Option.match(afterSequence, {
        onNone: () => Stream.empty,
        onSome: (sequence) =>
          threadEvents.stream({ afterSequence: sequence, eventType: "thread.metadata-updated" }),
      });
      const prompts = Stream.merge(
        committed.pipe(Stream.filter((event) => event.kind.startsWith("participant."))),
        renames,
      );
      return (sentRosterHash: string) =>
        prompts.pipe(
          Stream.mapEffect(() =>
            roster.list().pipe(Effect.map((entries) => peerRosterHash(toPeerRoster(entries)))),
          ),
          Stream.filter((rosterHash) => rosterHash !== sentRosterHash),
          Stream.runHead,
          // A source that fails leaves the poll to answer within the hold.
          Effect.catchCause(() => Effect.never),
          Effect.asVoid,
        );
    });

    /** One peer's loop, until polling stops. */
    const pollLoop = (environmentId: string) =>
      Effect.gen(function* () {
        let backoff = BACKOFF_START;
        while (true) {
          // Each poll listens for a roster change only while it is held, then lets go.
          const outcome = yield* Effect.scoped(
            Effect.flatMap(nextRosterChange, (rosterChange) => poll(environmentId, rosterChange)),
          );
          switch (outcome.kind) {
            case "stopped":
              return;
            case "failed":
              yield* Effect.sleep(backoff);
              backoff = Duration.min(Duration.times(backoff, 2), BACKOFF_CAP);
              break;
            case "cut":
              backoff = BACKOFF_START;
              yield* Effect.sleep(CUT_RETRY);
              break;
            default:
              backoff = BACKOFF_START;
          }
        }
      });

    if (daemon) {
      const scope = yield* Effect.scope;
      // One loop per poll peer. A loop that stopped is restarted only when the
      // peer is recorded again with a new credential, which is what fixes it.
      const running = new Map<
        string,
        { readonly credential: string | null; fiber: Fiber.Fiber<void> | null }
      >();
      const reconcile = Effect.gen(function* () {
        const connections = yield* peers
          .connections()
          .pipe(Effect.orElseSucceed(() => [] as const));
        const polled = new Map(
          connections
            .filter((peer) => peer.linkMode === "poll")
            .map((peer) => [peer.environmentId, peer.credential] as const),
        );
        for (const [environmentId, entry] of running) {
          if (polled.get(environmentId) === entry.credential) continue;
          if (entry.fiber !== null) yield* Fiber.interrupt(entry.fiber);
          running.delete(environmentId);
        }
        for (const [environmentId, credential] of polled) {
          if (running.has(environmentId)) continue;
          const entry: { readonly credential: string | null; fiber: Fiber.Fiber<void> | null } = {
            credential,
            fiber: null,
          };
          running.set(environmentId, entry);
          entry.fiber = yield* pollLoop(environmentId).pipe(
            Effect.ensuring(Effect.sync(() => (entry.fiber = null))),
            Effect.forkIn(scope),
          );
        }
      });
      const changes = yield* peers.subscribeChanges;
      yield* reconcile;
      yield* changes.pipe(
        Stream.runForEach(() => reconcile),
        Effect.forkIn(scope),
      );
    }

    return PeerPoller.of({ pollOnce });
  });

type PeerPollerRequirements =
  | PeerRegistryService
  | PeerInboundService
  | A2ADeliveryWorker
  | RosterService
  | A2ALedger
  | EventSinkV2
  | HttpClient.HttpClient;

/** The poller without its loops, for tests that drive each poll. */
export const manualLayer: Layer.Layer<PeerPoller, never, PeerPollerRequirements> = Layer.effect(
  PeerPoller,
  make(false),
);
/** One loop per poll peer, started with the server and following the peer registry. */
export const layer: Layer.Layer<PeerPoller, never, PeerPollerRequirements> = Layer.effect(
  PeerPoller,
  make(true),
);
