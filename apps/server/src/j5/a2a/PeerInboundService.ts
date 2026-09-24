import type { PeerDeliveryRequest } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { A2ALedger, type A2ALedgerError } from "./LedgerService.ts";
import { stablePart } from "./spawnIds.ts";
import { findPeerCounterparty, isRoutedElsewhere } from "./peerCounterparty.ts";
import {
  type CommEvent,
  CommCommandId,
  CorrelationId,
  ExchangeId,
  isHumanParticipantId,
  isMachineParticipantId,
  isPlatformParticipantId,
  LedgerMessageId,
  LIFECYCLE_PARTICIPANT_ID,
  Participant,
  ParticipantId,
  SILENCE_DETECTOR_PARTICIPANT_ID,
  SquadronId,
} from "./contracts.ts";

/**
 * The receiving side of a cross-server delivery. A peer's message becomes the
 * receiver Squadron's own `message.received` row, which the ledger projects into
 * the pending delivery the worker then carries to the agent's thread. An ask
 * also opens the Exchange here, so the local agent's reply is an ordinary
 * same-Squadron reply and the silence detector measures the debt; a reply
 * closes the Exchange the local agent opened. One command id per origin
 * message makes a retry a replay.
 */

export interface PeerInboundInput extends PeerDeliveryRequest {
  readonly originEnvironmentId: string;
}

export interface PeerInboundResult {
  readonly receivedSeq: number;
  readonly replay: boolean;
}

export class A2APeerReceiverNotFoundError extends Schema.TaggedError<A2APeerReceiverNotFoundError>()(
  "A2APeerReceiverNotFoundError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `No active agent ${this.participantId} is homed on this server.`;
  }
}

export class A2APeerReceiverNotDeliverableError extends Schema.TaggedError<A2APeerReceiverNotDeliverableError>()(
  "A2APeerReceiverNotDeliverableError",
  { participantId: Schema.String, reason: Schema.Literals(["human", "machine", "archived"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "human":
        return `${this.participantId} is a person; a person is never addressed across servers.`;
      case "machine":
        return `${this.participantId} is a machine participant and receives nothing.`;
      case "archived":
        return `${this.participantId} is archived and cannot receive.`;
    }
  }
}

export class A2APeerSenderNotOwnedError extends Schema.TaggedError<A2APeerSenderNotOwnedError>()(
  "A2APeerSenderNotOwnedError",
  { participantId: Schema.String, originEnvironmentId: Schema.String },
) {
  override get message(): string {
    return `Participant ${this.participantId} is not homed on the peer that sent this message (${this.originEnvironmentId}); a peer may speak only for its own agents.`;
  }
}

export class A2APeerAskIntentRequiredError extends Schema.TaggedError<A2APeerAskIntentRequiredError>()(
  "A2APeerAskIntentRequiredError",
  { messageId: Schema.String, reason: Schema.Literals(["exchange-id", "intent"]) },
) {
  override get message(): string {
    return this.reason === "intent"
      ? `Message ${this.messageId} is an ask without an intent.`
      : `Message ${this.messageId} is an ask without an Exchange id; an ask opens an Exchange or it is not an ask.`;
  }
}

/**
 * A peer speaks only for its agents. It may not deliver as a person, a machine
 * participant or the platform, and an agent's message travels on the peer
 * channel as a plain send, ask, follow-up or reply.
 */
export class A2APeerSenderNotAllowedError extends Schema.TaggedError<A2APeerSenderNotAllowedError>()(
  "A2APeerSenderNotAllowedError",
  {
    senderId: Schema.String,
    reason: Schema.Literals(["human", "machine", "platform", "channel", "role", "exchange"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "human":
        return `${this.senderId} is a person; a peer server may not deliver as a person.`;
      case "machine":
        return `${this.senderId} is a machine participant; a peer server may not deliver as one.`;
      case "platform":
        return `${this.senderId} is not a platform notice a peer may carry: only the lifecycle or silence detector, on its notice channel, ending an Exchange.`;
      case "channel":
        return `${this.senderId} must deliver on the peer envelope channel.`;
      case "role":
        return `${this.senderId} may send, ask, follow up or reply; a terminal notice is the platform's to send.`;
      case "exchange":
        return `${this.senderId} may end only an Exchange this peer is party to.`;
    }
  }
}

export type PeerInboundError =
  | SqlError
  | Schema.SchemaError
  | A2ALedgerError
  | A2APeerReceiverNotFoundError
  | A2APeerReceiverNotDeliverableError
  | A2APeerAskIntentRequiredError
  | A2APeerSenderNotAllowedError
  | A2APeerSenderNotOwnedError;

export interface PeerInboundServiceShape {
  readonly receive: (input: PeerInboundInput) => Effect.Effect<PeerInboundResult, PeerInboundError>;
}

export class PeerInboundService extends Context.Service<
  PeerInboundService,
  PeerInboundServiceShape
>()("t3/j5/a2a/PeerInboundService") {}

/** One receipt per origin message, whatever the peer retries. */
const peerReceiveCommandId = (input: {
  readonly originEnvironmentId: string;
  readonly messageId: string;
}) =>
  CommCommandId.make(
    `command:j5:a2a:peer:receive:${stablePart(input.originEnvironmentId)}:${stablePart(input.messageId)}`,
  );

/**
 * The message id this ledger keys the delivery by. The origin's id is
 * namespaced by its environment so a peer can never collide with, replay
 * into, or displace a local message or another peer's.
 */
const localMessageIdFor = (input: {
  readonly originEnvironmentId: string;
  readonly messageId: string;
}) =>
  LedgerMessageId.make(
    `message:j5:a2a:peer:${stablePart(input.originEnvironmentId)}:${stablePart(input.messageId)}`,
  );

/** Refuse the sender kinds, channels and roles a peer may not use, before anything is read. */
/**
 * Who a peer may speak as. Its agents, on the peer channel, never a terminal
 * notice. Or the platform itself, but only the two platform ids that ever end
 * an Exchange, each on its own notice channel, carrying the fact it ends with;
 * the receive path then checks the Exchange is one this peer is party to.
 */
const assertSenderShape = (input: PeerInboundInput) => {
  const senderId = ParticipantId.make(input.senderId);
  const refuse = (reason: A2APeerSenderNotAllowedError["reason"]) =>
    Effect.fail(new A2APeerSenderNotAllowedError({ senderId, reason }));
  if (isHumanParticipantId(senderId)) return refuse("human");
  if (isMachineParticipantId(senderId)) return refuse("machine");
  if (isPlatformParticipantId(senderId)) {
    const channelOf = {
      [LIFECYCLE_PARTICIPANT_ID]: "lifecycle_notice",
      [SILENCE_DETECTOR_PARTICIPANT_ID]: "silence_notice",
    } as const;
    const expectedChannel =
      senderId in channelOf ? channelOf[senderId as keyof typeof channelOf] : undefined;
    const wellFormed =
      expectedChannel !== undefined &&
      input.envelopeChannel === expectedChannel &&
      input.exchangeRole === "terminal_notice" &&
      input.exchangeId !== null &&
      input.terminal !== undefined;
    return wellFormed
      ? Effect.succeed({ senderId, platformNotice: true as const })
      : refuse("platform");
  }
  if (input.envelopeChannel !== "peer") return refuse("channel");
  if (input.exchangeRole === "terminal_notice") return refuse("role");
  return Effect.succeed({ senderId, platformNotice: false as const });
};

interface MembershipRow {
  readonly squadron_id: string;
  readonly payload: string;
  readonly archived_at: string | null;
}

interface ExchangeRow {
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly status: "open" | "closed" | "dropped";
}

const decodeParticipant = Schema.decodeUnknownEffect(Schema.fromJsonString(Participant));

export const layer: Layer.Layer<PeerInboundService, never, A2ALedger | SqlClient.SqlClient> =
  Layer.effect(
    PeerInboundService,
    Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const sql = yield* SqlClient.SqlClient;

      const localReceiver = Effect.fn("j5.a2a.peer.inbound.receiver")(function* (
        id: ParticipantId,
      ) {
        if (isHumanParticipantId(id)) {
          return yield* new A2APeerReceiverNotDeliverableError({
            participantId: id,
            reason: "human",
          });
        }
        if (isMachineParticipantId(id)) {
          return yield* new A2APeerReceiverNotDeliverableError({
            participantId: id,
            reason: "machine",
          });
        }
        const rows = yield* sql<MembershipRow>`
          SELECT squadron_id, payload, archived_at
          FROM j5_a2a_squadron_membership
          WHERE participant_id = ${id}
          LIMIT 2
        `;
        const row = rows.length === 1 ? rows[0] : undefined;
        if (row === undefined)
          return yield* new A2APeerReceiverNotFoundError({ participantId: id });
        if (row.archived_at !== null) {
          return yield* new A2APeerReceiverNotDeliverableError({
            participantId: id,
            reason: "archived",
          });
        }
        const participant = yield* decodeParticipant(row.payload);
        if (participant.kind !== "agent") {
          return yield* new A2APeerReceiverNotFoundError({ participantId: id });
        }
        return { squadronId: SquadronId.make(row.squadron_id), participant };
      });

      /**
       * A retry replays the first receipt whatever has happened to the receiver
       * since: the peer's acknowledgement was lost, not the fact it recorded.
       */
      const priorReceipt = Effect.fn("j5.a2a.peer.inbound.priorReceipt")(function* (
        commandId: CommCommandId,
      ) {
        const rows = yield* sql<{ readonly seq: number }>`
          SELECT seq FROM j5_a2a_comm_event
          WHERE command_id = ${commandId} AND kind = 'message.received'
          LIMIT 1
        `;
        return rows[0] === undefined
          ? null
          : ({ receivedSeq: rows[0].seq, replay: true } satisfies PeerInboundResult);
      });

      /**
       * A peer may speak only for agents it owns. An id homed here, or one the
       * ledger has already routed to a different peer, cannot be claimed by this
       * origin. First contact from an unknown id passes.
       */
      const assertSenderOwnedByOrigin = Effect.fn("j5.a2a.peer.inbound.senderOwned")(function* (
        senderId: ParticipantId,
        originEnvironmentId: string,
      ) {
        const local = yield* sql<{ readonly one: number }>`
          SELECT 1 AS one FROM j5_a2a_squadron_membership WHERE participant_id = ${senderId} LIMIT 1
        `;
        const owned =
          local[0] === undefined && !(yield* isRoutedElsewhere(sql, senderId, originEnvironmentId));
        if (!owned) {
          return yield* new A2APeerSenderNotOwnedError({
            participantId: senderId,
            originEnvironmentId,
          });
        }
      });

      const receive: PeerInboundServiceShape["receive"] = (input) =>
        Effect.gen(function* () {
          const commandId = peerReceiveCommandId({
            originEnvironmentId: input.originEnvironmentId,
            messageId: input.messageId,
          });
          const replayed = yield* priorReceipt(commandId);
          if (replayed !== null) return replayed;
          const { senderId, platformNotice } = yield* assertSenderShape(input);
          if (!platformNotice)
            yield* assertSenderOwnedByOrigin(senderId, input.originEnvironmentId);
          const receiverId = ParticipantId.make(input.receiverId);
          const receiver = yield* localReceiver(receiverId);
          const exchangeId = input.exchangeId === null ? null : ExchangeId.make(input.exchangeId);
          const correlationId = CorrelationId.make(input.correlationId);
          const messageId = localMessageIdFor(input);
          const originSquadronId = SquadronId.make(input.originSquadronId);
          // This ledger's clock stamps what happened here; the origin's time is kept for display.
          const receivedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          const events: Array<CommEvent> = [];

          if (input.exchangeRole === "ask") {
            if (exchangeId === null) {
              return yield* new A2APeerAskIntentRequiredError({
                messageId: input.messageId,
                reason: "exchange-id",
              });
            }
            if (input.intent === undefined) {
              return yield* new A2APeerAskIntentRequiredError({
                messageId: input.messageId,
                reason: "intent",
              });
            }
            events.push({
              kind: "exchange.opened",
              sender: senderId,
              receiver: receiverId,
              exchangeId,
              correlationId,
              payload: { intent: input.intent, urgency: null },
              createdAt: receivedAt,
            });
          }

          events.push({
            kind: "message.received",
            sender: senderId,
            receiver: receiverId,
            exchangeId,
            correlationId,
            payload: {
              originSquadronId,
              originEnvironmentId: input.originEnvironmentId,
              originMessageId: input.messageId,
              originCreatedAt: input.createdAt,
              // A withdrawal closes the debt here as it does at the origin: silently.
              ...(input.terminal?.kind === "sender-cleared" ? { injection: "none" as const } : {}),
              ...(input.senderLabel === undefined ? {} : { senderLabel: input.senderLabel }),
              message: {
                messageId,
                text: input.text,
                originSquadronId,
                receiverSquadronId: receiver.squadronId,
                exchangeRole: input.exchangeRole,
                envelopeChannel: input.envelopeChannel,
              },
            },
            createdAt: receivedAt,
          });

          /**
           * Only the peer that the ledger records as the Exchange's other party
           * may close or drop it here. A credential proves which server is
           * calling; this proves that server owns the participant it speaks for.
           */
          const exchangeWithPeer = Effect.fn("j5.a2a.peer.inbound.exchangeWithPeer")(function* (
            id: ExchangeId,
          ) {
            const rows = yield* sql<ExchangeRow>`
                SELECT exchange_id, sender_id, receiver_id, status
                FROM j5_a2a_exchange
                WHERE squadron_id = ${receiver.squadronId}
                  AND exchange_id = ${id}
                  AND (sender_id = ${receiverId} OR receiver_id = ${receiverId})
                LIMIT 1
              `;
            const row = rows[0];
            if (row === undefined) return null;
            const otherParty = ParticipantId.make(
              row.sender_id === receiverId ? row.receiver_id : row.sender_id,
            );
            const counterparty = yield* findPeerCounterparty(sql, {
              squadronId: receiver.squadronId,
              exchangeId: id,
              participantId: otherParty,
            });
            return counterparty?.environmentId === input.originEnvironmentId
              ? { row, otherParty }
              : null;
          });

          if (input.exchangeRole === "reply" && exchangeId !== null) {
            const open = yield* exchangeWithPeer(exchangeId);
            if (
              open !== null &&
              open.row.status === "open" &&
              open.row.sender_id === receiverId &&
              open.otherParty === senderId
            ) {
              events.push({
                kind: "exchange.closed",
                sender: senderId,
                receiver: receiverId,
                exchangeId,
                correlationId,
                payload: { replyMessageId: messageId },
                createdAt: receivedAt,
              });
            }
          }

          if (platformNotice && input.terminal !== undefined && exchangeId !== null) {
            // The origin ended the Exchange; this side holds the same Exchange and
            // ends it the same way. Which side retired is this ledger's to say.
            const party = yield* exchangeWithPeer(exchangeId);
            if (party === null) {
              return yield* new A2APeerSenderNotAllowedError({ senderId, reason: "exchange" });
            }
            const { row, otherParty } = party;
            if (
              row.status === "open" &&
              input.terminal.kind === "dropped" &&
              input.terminal.cause.participantId === otherParty
            ) {
              events.push({
                kind: "exchange.dropped",
                sender: ParticipantId.make(row.sender_id),
                receiver: ParticipantId.make(row.receiver_id),
                exchangeId,
                correlationId,
                payload: {
                  disposition: otherParty === row.sender_id ? "sender-retired" : "receiver-retired",
                  cause: {
                    kind: input.terminal.cause.kind,
                    participantId: otherParty,
                    squadronId: SquadronId.make(input.terminal.cause.squadronId),
                  },
                  facts: {
                    replyRequired: false,
                    retryAllowed: false,
                    replacementRequired: false,
                  },
                  noticeMessageId: messageId,
                },
                createdAt: receivedAt,
              });
            } else if (
              row.status === "open" &&
              input.terminal.kind === "sender-cleared" &&
              row.sender_id === otherParty
            ) {
              // The remote asker withdrew its own ask; the local answerer owes nothing more.
              events.push({
                kind: "exchange.closed",
                sender: otherParty,
                receiver: receiverId,
                exchangeId,
                correlationId,
                payload: { closureKind: "sender-cleared" },
                createdAt: receivedAt,
              });
            }
          }

          const appended = yield* ledger.appendEvents({
            commandId,
            squadronId: receiver.squadronId,
            acceptedAt: receivedAt,
            events,
          });
          const received = appended.events.find((event) => event.kind === "message.received");
          return {
            receivedSeq: received?.seq ?? appended.receipt.resultSeq,
            replay: !appended.committed,
          } satisfies PeerInboundResult;
        });

      return PeerInboundService.of({ receive });
    }),
  );
