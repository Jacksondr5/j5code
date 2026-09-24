import type { PeerDeliveryRequest } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { A2ALedger, type A2ALedgerError } from "./LedgerService.ts";
import { findPeerCounterparty } from "./peerCounterparty.ts";
import {
  type CommEvent,
  CommCommandId,
  CorrelationId,
  ExchangeId,
  isHumanParticipantId,
  isMachineParticipantId,
  LedgerMessageId,
  Participant,
  ParticipantId,
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
  { messageId: Schema.String },
) {
  override get message(): string {
    return `Message ${this.messageId} is an ask without an intent.`;
  }
}

export type PeerInboundError =
  | SqlError
  | Schema.SchemaError
  | A2ALedgerError
  | A2APeerReceiverNotFoundError
  | A2APeerReceiverNotDeliverableError
  | A2APeerSenderNotOwnedError
  | A2APeerAskIntentRequiredError;

export interface PeerInboundServiceShape {
  readonly receive: (input: PeerInboundInput) => Effect.Effect<PeerInboundResult, PeerInboundError>;
}

export class PeerInboundService extends Context.Service<
  PeerInboundService,
  PeerInboundServiceShape
>()("t3/j5/a2a/PeerInboundService") {}

const stablePart = (value: string) => encodeURIComponent(value);

/** One receipt per origin message, whatever the peer retries. */
export const peerReceiveCommandId = (input: {
  readonly originEnvironmentId: string;
  readonly messageId: string;
}) =>
  CommCommandId.make(
    `command:j5:a2a:peer:receive:${stablePart(input.originEnvironmentId)}:${stablePart(input.messageId)}`,
  );

interface MembershipRow {
  readonly squadron_id: string;
  readonly payload: string;
  readonly archived_at: string | null;
}

interface OpenExchangeRow {
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
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
        input: PeerInboundInput,
      ) {
        const commandId = peerReceiveCommandId({
          originEnvironmentId: input.originEnvironmentId,
          messageId: input.messageId,
        });
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
       * origin. Platform senders and first contact from an unknown id pass.
       */
      const assertSenderOwnedByOrigin = Effect.fn("j5.a2a.peer.inbound.senderOwned")(function* (
        senderId: ParticipantId,
        originEnvironmentId: string,
      ) {
        if (senderId.startsWith("platform:")) return;
        const local = yield* sql<{ readonly one: number }>`
          SELECT 1 AS one FROM j5_a2a_squadron_membership WHERE participant_id = ${senderId} LIMIT 1
        `;
        if (local[0] !== undefined) {
          return yield* new A2APeerSenderNotOwnedError({
            participantId: senderId,
            originEnvironmentId,
          });
        }
        const routed = yield* sql<{ readonly environment_id: string }>`
          SELECT receiver_environment_id AS environment_id FROM j5_a2a_delivery
          WHERE receiver_id = ${senderId} AND receiver_environment_id IS NOT NULL
          UNION ALL
          SELECT json_extract(payload, '$.originEnvironmentId') AS environment_id FROM j5_a2a_comm_event
          WHERE kind = 'message.received' AND sender = ${senderId}
            AND json_extract(payload, '$.originEnvironmentId') IS NOT NULL
        `;
        if (routed.some((row) => row.environment_id !== originEnvironmentId)) {
          return yield* new A2APeerSenderNotOwnedError({
            participantId: senderId,
            originEnvironmentId,
          });
        }
      });

      const receive: PeerInboundServiceShape["receive"] = (input) =>
        Effect.gen(function* () {
          const replayed = yield* priorReceipt(input);
          if (replayed !== null) return replayed;
          const receiverId = ParticipantId.make(input.receiverId);
          const senderId = ParticipantId.make(input.senderId);
          yield* assertSenderOwnedByOrigin(senderId, input.originEnvironmentId);
          const receiver = yield* localReceiver(receiverId);
          const exchangeId = input.exchangeId === null ? null : ExchangeId.make(input.exchangeId);
          const correlationId = CorrelationId.make(input.correlationId);
          const messageId = LedgerMessageId.make(input.messageId);
          const originSquadronId = SquadronId.make(input.originSquadronId);
          const events: Array<CommEvent> = [];

          if (input.exchangeRole === "ask" && exchangeId !== null) {
            if (input.intent === undefined) {
              return yield* new A2APeerAskIntentRequiredError({ messageId: input.messageId });
            }
            events.push({
              kind: "exchange.opened",
              sender: senderId,
              receiver: receiverId,
              exchangeId,
              correlationId,
              payload: { intent: input.intent, urgency: null },
              createdAt: input.createdAt,
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
              message: {
                messageId,
                text: input.text,
                originSquadronId,
                receiverSquadronId: receiver.squadronId,
                exchangeRole: input.exchangeRole,
                envelopeChannel: input.envelopeChannel,
              },
            },
            createdAt: input.createdAt,
          });

          /**
           * Only the peer that the ledger records as the Exchange's other party
           * may close or drop it here. A credential proves which server is
           * calling; this proves that server owns the participant it speaks for.
           */
          const openExchangeWithPeer = Effect.fn("j5.a2a.peer.inbound.openExchangeWithPeer")(
            function* (id: ExchangeId) {
              const rows = yield* sql<OpenExchangeRow>`
                SELECT exchange_id, sender_id, receiver_id
                FROM j5_a2a_exchange
                WHERE squadron_id = ${receiver.squadronId}
                  AND exchange_id = ${id}
                  AND status = 'open'
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
            },
          );

          if (input.exchangeRole === "reply" && exchangeId !== null) {
            const open = yield* openExchangeWithPeer(exchangeId);
            if (
              open !== null &&
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
                createdAt: input.createdAt,
              });
            }
          }

          if (
            input.exchangeRole === "terminal_notice" &&
            input.terminal !== undefined &&
            exchangeId !== null
          ) {
            // The origin ended the Exchange; this side holds the same Exchange and ends it the same way.
            const open = yield* openExchangeWithPeer(exchangeId);
            if (
              open !== null &&
              input.terminal.kind === "dropped" &&
              input.terminal.cause.participantId === open.otherParty
            ) {
              events.push({
                kind: "exchange.dropped",
                sender: ParticipantId.make(open.row.sender_id),
                receiver: ParticipantId.make(open.row.receiver_id),
                exchangeId,
                correlationId,
                payload: {
                  disposition: input.terminal.disposition,
                  cause: {
                    kind: input.terminal.cause.kind,
                    participantId: open.otherParty,
                    squadronId: SquadronId.make(input.terminal.cause.squadronId),
                  },
                  facts: {
                    replyRequired: false,
                    retryAllowed: false,
                    replacementRequired: false,
                  },
                  noticeMessageId: messageId,
                },
                createdAt: input.createdAt,
              });
            } else if (
              open !== null &&
              input.terminal.kind === "sender-cleared" &&
              open.row.sender_id === open.otherParty
            ) {
              // The remote asker withdrew its own ask; the local answerer owes nothing more.
              events.push({
                kind: "exchange.closed",
                sender: open.otherParty,
                receiver: receiverId,
                exchangeId,
                correlationId,
                payload: { closureKind: "sender-cleared" },
                createdAt: input.createdAt,
              });
            }
          }

          const appended = yield* ledger.appendEvents({
            commandId: peerReceiveCommandId({
              originEnvironmentId: input.originEnvironmentId,
              messageId: input.messageId,
            }),
            squadronId: receiver.squadronId,
            acceptedAt: input.createdAt,
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
