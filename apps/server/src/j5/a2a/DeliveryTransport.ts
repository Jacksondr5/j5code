import { CommandId, MessageId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { formatHumanEnvelope, formatPeerEnvelope } from "./EnvelopeFormatter.ts";
import {
  type DeliveryEnvelopeChannel,
  SquadronId,
  ExchangeId,
  GLOBAL_HUMAN_PARTICIPANT_ID,
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

const decodeParticipant = Schema.decodeUnknownEffect(Schema.fromJsonString(Participant));

const assertNever = (channel: never): never => {
  throw new Error(`Unsupported A2A delivery envelope channel: ${String(channel)}`);
};

export const formatAgentDeliveryEnvelope = (input: AgentDeliveryInput): string => {
  switch (input.envelopeChannel) {
    case "peer":
      return input.senderId === GLOBAL_HUMAN_PARTICIPANT_ID
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
              input.envelopeChannel === "silence_notice"
                ? "system"
                : input.senderId === GLOBAL_HUMAN_PARTICIPANT_ID
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
        sql`
            INSERT INTO j5_a2a_human_inbox_data (
              origin_squadron_id,
              message_id,
              exchange_id,
              sender_id,
              payload,
              created_at
            ) VALUES (
              ${input.originSquadronId},
              ${input.messageId},
              ${input.exchangeId},
              ${input.senderId},
              ${input.message},
              ${input.createdAt}
            )
            ON CONFLICT(origin_squadron_id, message_id) DO NOTHING
          `.pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) => new A2ADeliveryTransportError({ operation: "deliver human", cause }),
          ),
        ),
    });
  }),
);
