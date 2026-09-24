import type { PeerDeliveryRequest } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { A2ALedger, type A2ALedgerError } from "./LedgerService.ts";
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

      const receive: PeerInboundServiceShape["receive"] = (input) =>
        Effect.gen(function* () {
          const replayed = yield* priorReceipt(input);
          if (replayed !== null) return replayed;
          const receiverId = ParticipantId.make(input.receiverId);
          const senderId = ParticipantId.make(input.senderId);
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

          if (input.exchangeRole === "reply" && exchangeId !== null) {
            const open = yield* sql<OpenExchangeRow>`
              SELECT exchange_id
              FROM j5_a2a_exchange
              WHERE squadron_id = ${receiver.squadronId}
                AND exchange_id = ${exchangeId}
                AND status = 'open'
                AND sender_id = ${receiverId}
                AND receiver_id = ${senderId}
              LIMIT 1
            `;
            if (open[0] !== undefined) {
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
