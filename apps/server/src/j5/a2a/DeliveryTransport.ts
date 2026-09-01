import { CommandId, MessageId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import {
  formatClosedHumanEnvelope,
  formatClosedPeerEnvelope,
  formatHumanEnvelope,
  formatPeerEnvelope,
} from "./EnvelopeFormatter.ts";
import {
  type DeliveryEnvelopeChannel,
  SquadronId,
  ExchangeId,
  isHumanParticipantId,
  Participant,
  ParticipantId,
  type LedgerMessageId,
} from "./contracts.ts";

export class A2ADeliveryTargetError extends Schema.TaggedErrorClass<A2ADeliveryTargetError>()(
  "A2ADeliveryTargetError",
  {
    participantId: Schema.String,
    state: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot deliver to ${this.participantId}: ${this.state}. Call list_participants before sending again.`;
  }
}

export class A2ADeliveryTransportError extends Schema.TaggedErrorClass<A2ADeliveryTransportError>()(
  "A2ADeliveryTransportError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface AgentDeliveryInput {
  readonly originSquadronId: SquadronId;
  readonly receiverSquadronId: SquadronId;
  readonly messageId: LedgerMessageId;
  readonly senderId: ParticipantId;
  readonly receiverId: ParticipantId;
  readonly exchangeId: ExchangeId | null;
  readonly exchangeRole: "none" | "ask" | "followup" | "reply" | "terminal_notice";
  readonly message: string;
  readonly envelopeChannel: DeliveryEnvelopeChannel;
}

export interface HumanDeliveryInput extends AgentDeliveryInput {
  readonly createdAt: string;
}

export interface A2ADeliveryTransportShape {
  readonly deliverAgent: (
    input: AgentDeliveryInput,
  ) => Effect.Effect<void, A2ADeliveryTransportError>;
  readonly deliverHuman: (
    input: HumanDeliveryInput,
  ) => Effect.Effect<void, A2ADeliveryTransportError>;
}

export class A2ADeliveryTransport extends Context.Service<
  A2ADeliveryTransport,
  A2ADeliveryTransportShape
>()("t3/j5/a2a/DeliveryTransport/A2ADeliveryTransport") {}

const stablePart = (value: string) => encodeURIComponent(value);

/**
 * Every retry reuses this upstream command/message pair. A rejected upstream
 * receipt therefore exhausts into the visible alarm instead of rotating an id
 * that could double-inject after an ambiguous post-commit failure.
 */
export const deliveryCommandId = (messageId: LedgerMessageId) =>
  CommandId.make(`command:j5:a2a:delivery:${stablePart(messageId)}`);

export const deliveryMessageId = (messageId: LedgerMessageId) =>
  MessageId.make(`message:j5:a2a:delivery:${stablePart(messageId)}`);

interface MembershipRow {
  readonly payload: string;
}

interface HumanExchangeRow {
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly status: "open" | "closed" | "dropped";
  readonly intent: string;
  readonly urgency: "blocking" | "soon" | "fyi" | null;
  readonly opened_seq: number;
  readonly created_at: string;
}

const decodeParticipant = Schema.decodeUnknownEffect(Schema.fromJsonString(Participant));

const assertNever = (channel: never): never => {
  throw new Error(`Unsupported A2A delivery envelope channel: ${String(channel)}`);
};

export const formatAgentDeliveryEnvelope = (input: AgentDeliveryInput): string => {
  switch (input.envelopeChannel) {
    case "peer":
      return input.exchangeRole === "reply"
        ? isHumanParticipantId(input.senderId)
          ? formatClosedHumanEnvelope({
              senderId: input.senderId,
              message: input.message,
            })
          : formatClosedPeerEnvelope({
              senderId: input.senderId,
              originSquadronId: input.originSquadronId,
              message: input.message,
            })
        : isHumanParticipantId(input.senderId)
          ? formatHumanEnvelope({
              senderId: input.senderId,
              exchangeId: input.exchangeId,
              message: input.message,
            })
          : formatPeerEnvelope({
              senderId: input.senderId,
              originSquadronId: input.originSquadronId,
              exchangeId: input.exchangeId,
              message: input.message,
            });
    case "silence_notice":
    case "lifecycle_notice":
      return input.message;
    default:
      return assertNever(input.envelopeChannel);
  }
};

export const live: Layer.Layer<
  A2ADeliveryTransport,
  never,
  ThreadManagement.ThreadManagementService | SqlClient.SqlClient
> = Layer.effect(
  A2ADeliveryTransport,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sql = yield* SqlClient.SqlClient;

    return A2ADeliveryTransport.of({
      deliverAgent: (input) =>
        Effect.gen(function* () {
          const rows = yield* sql<MembershipRow>`
            SELECT payload
            FROM j5_a2a_squadron_membership
            WHERE squadron_id = ${input.receiverSquadronId}
              AND participant_id = ${input.receiverId}
            LIMIT 1
          `;
          const row = rows[0];
          if (row === undefined) {
            return yield* new A2ADeliveryTargetError({
              participantId: input.receiverId,
              state: "membership disappeared before delivery",
            });
          }
          const participant = yield* decodeParticipant(row.payload);
          if (participant.kind !== "agent") {
            return yield* new A2ADeliveryTargetError({
              participantId: input.receiverId,
              state: "participant is not an addressable agent thread",
            });
          }
          const target = yield* threads.getThreadProjection(participant.threadId);
          // Interject peer traffic into a busy agent's active turn so blocked-on-peer
          // work resumes before silence classification. Queue mode starts immediately
          // when idle without reintroducing ThreadManagement's implicit auto branch.
          const mode =
            ThreadManagement.latestSteerableRun(target) === undefined ? "queue" : "steer";
          const envelope = formatAgentDeliveryEnvelope(input);
          yield* threads.sendToThread({
            projectId: target.thread.projectId,
            commandId: deliveryCommandId(input.messageId),
            threadId: participant.threadId,
            messageId: deliveryMessageId(input.messageId),
            text: envelope,
            attachments: [],
            mode,
            createdBy:
              input.envelopeChannel === "silence_notice" ||
              input.envelopeChannel === "lifecycle_notice"
                ? "system"
                : isHumanParticipantId(input.senderId)
                  ? "user"
                  : "agent",
            creationSource: "mcp",
          });
        }).pipe(
          Effect.mapError(
            (cause) => new A2ADeliveryTransportError({ operation: "deliver agent", cause }),
          ),
        ),
      deliverHuman: (input) =>
        input.envelopeChannel === "lifecycle_notice"
          ? Effect.void
          : Effect.gen(function* () {
              yield* sql`
            INSERT INTO j5_a2a_human_inbox_data (
              origin_squadron_id,
              message_id,
              exchange_id,
              sender_id,
              receiver_id,
              payload,
              created_at
            ) VALUES (
              ${input.originSquadronId},
              ${input.messageId},
              ${input.exchangeId},
              ${input.senderId},
              ${input.receiverId},
              ${input.message},
              ${input.createdAt}
            )
            ON CONFLICT(origin_squadron_id, message_id) DO NOTHING
          `;
              if (input.exchangeId === null) return;
              const exchanges = yield* sql<HumanExchangeRow>`
            SELECT sender_id, receiver_id, status, intent, urgency, opened_seq, created_at
            FROM j5_a2a_exchange
            WHERE squadron_id = ${input.originSquadronId}
              AND exchange_id = ${input.exchangeId}
              AND receiver_id = ${input.receiverId}
            LIMIT 1
          `;
              const exchange = exchanges[0];
              if (exchange === undefined || exchange.urgency === null) {
                return yield* new A2ADeliveryTargetError({
                  participantId: input.receiverId,
                  state: "person-addressed exchange disappeared before inbox projection",
                });
              }
              // A follow-up may still be pending when the person answers or
              // lifecycle closure drops the exchange. The raw peer message is
              // durable above, but a discharged obligation has no active inbox
              // row to update and is a successful projection no-op.
              if (exchange.status !== "open") return;
              yield* sql`
            INSERT INTO j5_a2a_human_inbox (
              person_id,
              squadron_id,
              exchange_id,
              sender_id,
              intent,
              urgency,
              latest_message_id,
              latest_message,
              opened_seq,
              opened_at,
              status,
              terminal_seq,
              terminal_at,
              terminal_disposition,
              terminal_cause,
              terminal_facts,
              terminal_notice_message_id
            ) VALUES (
              ${input.receiverId},
              ${input.originSquadronId},
              ${input.exchangeId},
              ${exchange.sender_id},
              ${exchange.intent},
              ${exchange.urgency},
              ${input.messageId},
              ${input.message},
              ${exchange.opened_seq},
              ${exchange.created_at},
              'open',
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL
            )
            ON CONFLICT(person_id, squadron_id, exchange_id) DO UPDATE SET
              latest_message_id = excluded.latest_message_id,
              latest_message = excluded.latest_message
            WHERE j5_a2a_human_inbox.status = 'open'
          `;
            }).pipe(
              Effect.asVoid,
              Effect.mapError(
                (cause) => new A2ADeliveryTransportError({ operation: "deliver human", cause }),
              ),
            ),
    });
  }),
);
