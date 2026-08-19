import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  CommCommandId,
  type CommEvent,
  CorrelationId,
  SquadronId,
  ExchangeId,
  GLOBAL_HUMAN_PARTICIPANT_ID,
  LedgerMessageId,
  Participant,
  type ParticipantDirectoryRow,
  type ParticipantId,
  type SendMessageInput,
  type SendMessageResult,
  participantId,
} from "./contracts.ts";
import { type A2AHomeLookupError, resolveThreadHome } from "./HomeRegistrar.ts";
import { A2ALedger, type A2ALedgerError } from "./LedgerService.ts";

export class A2ASenderNotJoinedError extends Schema.TaggedErrorClass<A2ASenderNotJoinedError>()(
  "A2ASenderNotJoinedError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Cross-agent messaging is unavailable for native thread ${this.threadId} because it has no registered home squadron. No native user-created-thread hook consumes the internal registrar at this head. The sanctioned future production path is the A6 creation wrapper; controlled tests may seed membership directly. Stop this messaging attempt.`;
  }
}

export class A2AParticipantNotFoundError extends Schema.TaggedErrorClass<A2AParticipantNotFoundError>()(
  "A2AParticipantNotFoundError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `Participant ${this.participantId} is not currently reachable. Call list_participants and choose a row with canReceiveMessage=true.`;
  }
}

export class A2AAmbiguousParticipantError extends Schema.TaggedErrorClass<A2AAmbiguousParticipantError>()(
  "A2AAmbiguousParticipantError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `Participant ${this.participantId} is active in more than one squadron and cannot be addressed unambiguously. Call list_participants and choose a participantId with canReceiveMessage=true, or ask the human to repair squadron membership.`;
  }
}

export class A2AIntentRequiredError extends Schema.TaggedErrorClass<A2AIntentRequiredError>()(
  "A2AIntentRequiredError",
  {},
) {
  override get message(): string {
    return "Opening an exchange requires intent. Retry send_message with a one-line intent summary.";
  }
}

export class A2AUrgencyRequiredError extends Schema.TaggedErrorClass<A2AUrgencyRequiredError>()(
  "A2AUrgencyRequiredError",
  {},
) {
  override get message(): string {
    return "Opening an exchange to the human requires urgency=blocking|soon|fyi. Retry send_message with urgency.";
  }
}

export class A2AUrgencyNotAcceptedError extends Schema.TaggedErrorClass<A2AUrgencyNotAcceptedError>()(
  "A2AUrgencyNotAcceptedError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `Participant ${this.participantId} does not accept urgency. Retry send_message without urgency.`;
  }
}

export class A2AUrgencyRequiresExchangeError extends Schema.TaggedErrorClass<A2AUrgencyRequiresExchangeError>()(
  "A2AUrgencyRequiresExchangeError",
  {},
) {
  override get message(): string {
    return "Urgency applies only when opening a reply-expected exchange to the human. Retry without urgency, or set expect_reply=true with intent and urgency.";
  }
}

export class A2AExchangeNotOpenError extends Schema.TaggedErrorClass<A2AExchangeNotOpenError>()(
  "A2AExchangeNotOpenError",
  { exchangeId: Schema.String },
) {
  override get message(): string {
    return `Exchange ${this.exchangeId} is not open. Call send_message without exchange_id to start a new message or exchange.`;
  }
}

export class A2AExchangeParticipantMismatchError extends Schema.TaggedErrorClass<A2AExchangeParticipantMismatchError>()(
  "A2AExchangeParticipantMismatchError",
  {
    exchangeId: Schema.String,
    senderId: Schema.String,
    receiverId: Schema.String,
  },
) {
  override get message(): string {
    return `Exchange ${this.exchangeId} does not connect ${this.senderId} to ${this.receiverId}. Call list_participants and use the exchange's original peer.`;
  }
}

export class A2AExchangeAlreadyAnsweredError extends Schema.TaggedErrorClass<A2AExchangeAlreadyAnsweredError>()(
  "A2AExchangeAlreadyAnsweredError",
  { exchangeId: Schema.String },
) {
  override get message(): string {
    return `Exchange ${this.exchangeId} already has its one durable reply and is closing or closed. Call send_message without exchange_id to start a new message or exchange.`;
  }
}

export type A2ASendError =
  | A2ALedgerError
  | A2AHomeLookupError
  | Schema.SchemaError
  | SqlError
  | A2ASenderNotJoinedError
  | A2AParticipantNotFoundError
  | A2AAmbiguousParticipantError
  | A2AIntentRequiredError
  | A2AUrgencyRequiredError
  | A2AUrgencyNotAcceptedError
  | A2AUrgencyRequiresExchangeError
  | A2AExchangeNotOpenError
  | A2AExchangeAlreadyAnsweredError
  | A2AExchangeParticipantMismatchError;

interface MembershipRow {
  readonly squadron_id: string;
  readonly participant_id: string;
  readonly thread_id: string | null;
  readonly payload: string;
}

interface ExchangeRow {
  readonly squadron_id: string;
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly status: "open" | "closed";
}

interface ExistingMessageRow {
  readonly squadron_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly exchange_id: string | null;
  readonly exchange_role: "none" | "ask" | "followup" | "reply";
  readonly sent_seq: number;
}

const decodeParticipant = Schema.decodeUnknownEffect(Schema.fromJsonString(Participant));

const messageIdFor = (commandId: CommCommandId) =>
  LedgerMessageId.make(`message:j5:a2a:${encodeURIComponent(commandId)}`);

const exchangeIdFor = (commandId: CommCommandId) =>
  ExchangeId.make(`exchange:j5:a2a:${encodeURIComponent(commandId)}`);

const correlationIdFor = (commandId: CommCommandId) =>
  CorrelationId.make(`correlation:j5:a2a:${encodeURIComponent(commandId)}`);

export interface A2ASendServiceShape {
  readonly send: (input: SendMessageInput) => Effect.Effect<SendMessageResult, A2ASendError>;
  readonly listParticipants: (
    senderThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ParticipantDirectoryRow>, A2ASendError>;
}

export class A2ASendService extends Context.Service<A2ASendService, A2ASendServiceShape>()(
  "t3/j5/a2a/SendService/A2ASendService",
) {}

export const layer: Layer.Layer<A2ASendService, never, A2ALedger | SqlClient.SqlClient> =
  Layer.effect(
    A2ASendService,
    Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const sql = yield* SqlClient.SqlClient;

      const membershipRows = Effect.fn("j5.a2a.send.membershipRows")(function* () {
        return yield* sql<MembershipRow>`
          SELECT squadron_id, participant_id, thread_id, payload
          FROM j5_a2a_squadron_membership
          ORDER BY squadron_id, participant_id
        `;
      });

      const senderMembership = Effect.fn("j5.a2a.send.senderMembership")(function* (
        threadId: ThreadId,
      ) {
        const home = yield* resolveThreadHome(sql, threadId).pipe(
          Effect.catchTag("A2AHomeNotFoundError", () =>
            Effect.fail(new A2ASenderNotJoinedError({ threadId })),
          ),
        );
        const matches = (yield* membershipRows()).filter(
          (row) =>
            row.squadron_id === home.squadronId &&
            row.participant_id === home.participantId &&
            row.thread_id === threadId,
        );
        if (matches.length !== 1) {
          return yield* new A2ASenderNotJoinedError({ threadId });
        }
        return home;
      });

      const participantMembership = Effect.fn("j5.a2a.send.participantMembership")(function* (
        id: ParticipantId,
        senderSquadronId: SquadronId,
      ) {
        const matches = (yield* membershipRows()).filter((row) => row.participant_id === id);
        if (id === GLOBAL_HUMAN_PARTICIPANT_ID) {
          const local = matches.find((row) => row.squadron_id === senderSquadronId);
          if (local === undefined) {
            return yield* new A2AParticipantNotFoundError({ participantId: id });
          }
          return {
            squadronId: senderSquadronId,
            participant: yield* decodeParticipant(local.payload),
          };
        }
        if (matches.length === 0) {
          return yield* new A2AParticipantNotFoundError({ participantId: id });
        }
        if (matches.length > 1) {
          return yield* new A2AAmbiguousParticipantError({ participantId: id });
        }
        return {
          squadronId: SquadronId.make(matches[0]!.squadron_id),
          participant: yield* decodeParticipant(matches[0]!.payload),
        };
      });

      const listParticipants: A2ASendServiceShape["listParticipants"] = (senderThreadId) =>
        Effect.gen(function* () {
          const sender = yield* senderMembership(senderThreadId);
          const rows = yield* membershipRows();
          const membershipCounts = new Map<string, number>();
          for (const row of rows) {
            membershipCounts.set(
              row.participant_id,
              (membershipCounts.get(row.participant_id) ?? 0) + 1,
            );
          }
          const selected = rows.filter(
            (row) =>
              row.participant_id !== GLOBAL_HUMAN_PARTICIPANT_ID ||
              row.squadron_id === sender.squadronId,
          );
          return yield* Effect.forEach(
            selected,
            (row) =>
              decodeParticipant(row.payload).pipe(
                Effect.map((participant) => {
                  const id = participantId(participant);
                  const addressable =
                    id === GLOBAL_HUMAN_PARTICIPANT_ID || membershipCounts.get(id) === 1;
                  return {
                    squadronId: SquadronId.make(row.squadron_id),
                    participantId: id,
                    participant,
                    canReceiveMessage: addressable,
                    canOpenExchange: addressable,
                    acceptsUrgency: participant.kind === "human",
                  };
                }),
              ),
            { concurrency: 1 },
          );
        });

      const replayedSend = Effect.fn("j5.a2a.send.replayedSend")(function* (
        messageId: LedgerMessageId,
        senderId: ParticipantId,
      ) {
        const rows = yield* sql<ExistingMessageRow>`
          SELECT
            squadron_id,
            sender_id,
            receiver_id,
            exchange_id,
            exchange_role,
            sent_seq
          FROM j5_a2a_delivery
          WHERE message_id = ${messageId}
            AND sender_id = ${senderId}
          LIMIT 2
        `;
        if (rows.length !== 1) return null;
        const row = rows[0]!;
        const exchange =
          row.exchange_id === null
            ? []
            : yield* sql<ExchangeRow>`
                SELECT squadron_id, exchange_id, sender_id, receiver_id, status
                FROM j5_a2a_exchange
                WHERE exchange_id = ${row.exchange_id}
                LIMIT 1
              `;
        const isCrossSquadronReply =
          exchange[0] !== undefined &&
          exchange[0].squadron_id !== row.squadron_id &&
          exchange[0].receiver_id === row.sender_id &&
          exchange[0].sender_id === row.receiver_id;
        return {
          messageId,
          exchangeId: row.exchange_id === null ? null : ExchangeId.make(row.exchange_id),
          exchangeState:
            row.exchange_role === "none"
              ? ("none" as const)
              : row.exchange_role !== "reply"
                ? ("open" as const)
                : isCrossSquadronReply
                  ? ("closing" as const)
                  : ("closed" as const),
          joinedExistingExchange: row.exchange_role === "followup",
          durableAtSeq: row.sent_seq,
        } satisfies SendMessageResult;
      });

      const send: A2ASendServiceShape["send"] = (input) =>
        Effect.gen(function* () {
          const messageId = messageIdFor(input.commandId);
          const sender = yield* senderMembership(input.senderThreadId);
          const replay = yield* replayedSend(messageId, sender.participantId);
          if (replay !== null) return replay;

          const receiver = yield* participantMembership(input.to, sender.squadronId);
          const receiverId = participantId(receiver.participant);
          let exchangeId: ExchangeId | null = null;
          let exchangeState: SendMessageResult["exchangeState"] = "none";
          let exchangeRole: "none" | "ask" | "followup" | "reply" = "none";
          let joinedExistingExchange = false;
          let openEvent: CommEvent | undefined;
          let closeEvent: CommEvent | undefined;

          if (input.exchangeId !== undefined) {
            if (input.urgency !== undefined) {
              return yield* new A2AUrgencyRequiresExchangeError();
            }
            const rows = yield* sql<ExchangeRow>`
              SELECT squadron_id, exchange_id, sender_id, receiver_id, status
              FROM j5_a2a_exchange
              WHERE exchange_id = ${input.exchangeId}
              LIMIT 2
            `;
            const exchange = rows.length === 1 ? rows[0] : undefined;
            if (exchange === undefined || exchange.status !== "open") {
              return yield* new A2AExchangeNotOpenError({ exchangeId: input.exchangeId });
            }
            const isFollowup =
              exchange.sender_id === sender.participantId && exchange.receiver_id === receiverId;
            const isReply =
              exchange.receiver_id === sender.participantId && exchange.sender_id === receiverId;
            if (!isFollowup && !isReply) {
              return yield* new A2AExchangeParticipantMismatchError({
                exchangeId: input.exchangeId,
                senderId: sender.participantId,
                receiverId,
              });
            }
            exchangeId = input.exchangeId;
            joinedExistingExchange = isFollowup;
            if (isReply) {
              const acceptedReplies = yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count
                FROM j5_a2a_delivery
                WHERE exchange_id = ${exchangeId} AND exchange_role = 'reply'
              `;
              if ((acceptedReplies[0]?.count ?? 0) > 0) {
                return yield* new A2AExchangeAlreadyAnsweredError({ exchangeId });
              }
              exchangeRole = "reply";
              exchangeState = exchange.squadron_id === sender.squadronId ? "closed" : "closing";
              if (exchange.squadron_id === sender.squadronId) {
                closeEvent = {
                  kind: "exchange.closed",
                  sender: sender.participantId,
                  receiver: receiverId,
                  exchangeId,
                  correlationId: correlationIdFor(input.commandId),
                  payload: { replyMessageId: messageId },
                  createdAt: input.acceptedAt,
                };
              }
            } else {
              exchangeRole = "followup";
              exchangeState = "open";
            }
          } else if (input.expectReply === true) {
            const existing = yield* sql<ExchangeRow>`
              SELECT squadron_id, exchange_id, sender_id, receiver_id, status
              FROM j5_a2a_exchange
              WHERE squadron_id = ${sender.squadronId}
                AND sender_id = ${sender.participantId}
                AND receiver_id = ${receiverId}
                AND status = 'open'
              LIMIT 1
            `;
            if (existing[0] !== undefined) {
              exchangeId = ExchangeId.make(existing[0].exchange_id);
              joinedExistingExchange = true;
              exchangeRole = "followup";
            } else {
              if (input.intent === undefined) return yield* new A2AIntentRequiredError();
              if (receiver.participant.kind === "human" && input.urgency === undefined) {
                return yield* new A2AUrgencyRequiredError();
              }
              if (receiver.participant.kind !== "human" && input.urgency !== undefined) {
                return yield* new A2AUrgencyNotAcceptedError({ participantId: receiverId });
              }
              exchangeId = exchangeIdFor(input.commandId);
              exchangeRole = "ask";
              openEvent = {
                kind: "exchange.opened",
                sender: sender.participantId,
                receiver: receiverId,
                exchangeId,
                correlationId: correlationIdFor(input.commandId),
                payload: {
                  intent: input.intent,
                  urgency: input.urgency ?? null,
                },
                createdAt: input.acceptedAt,
              };
            }
            exchangeState = "open";
          } else if (input.urgency !== undefined) {
            return yield* new A2AUrgencyRequiresExchangeError();
          }

          const correlationId = correlationIdFor(input.commandId);
          const result = yield* ledger.appendEvents({
            commandId: input.commandId,
            squadronId: sender.squadronId,
            acceptedAt: input.acceptedAt,
            events: [
              ...(openEvent === undefined ? [] : [openEvent]),
              {
                kind: "message.sent",
                sender: sender.participantId,
                receiver: receiverId,
                exchangeId,
                correlationId,
                payload: {
                  messageId,
                  text: input.message,
                  originSquadronId: sender.squadronId,
                  receiverSquadronId: receiver.squadronId,
                  exchangeRole,
                  envelopeChannel: "peer",
                },
                createdAt: input.acceptedAt,
              },
              ...(closeEvent === undefined ? [] : [closeEvent]),
            ],
          });
          const sent = result.events.find((event) => event.kind === "message.sent");
          if (sent === undefined) {
            return yield* new A2AParticipantNotFoundError({ participantId: receiverId });
          }
          const opened = result.events.some((event) => event.kind === "exchange.opened");
          const closed = result.events.some((event) => event.kind === "exchange.closed");
          return {
            messageId,
            exchangeId,
            exchangeState: closed ? "closed" : exchangeState,
            joinedExistingExchange:
              exchangeId !== null && !opened && !closed ? joinedExistingExchange : false,
            durableAtSeq: sent.seq,
          } satisfies SendMessageResult;
        });

      return A2ASendService.of({ send, listParticipants });
    }),
  );
