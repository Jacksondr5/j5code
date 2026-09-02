import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  type ClearOwnAskInput,
  type ClearOwnAskResult,
  CommCommandId,
  type CommEvent,
  CorrelationId,
  SquadronId,
  ExchangeId,
  isHumanParticipantId,
  LedgerMessageId,
  Participant,
  type ParticipantDirectoryRow,
  ParticipantId,
  type SendMessageInput,
  type SendMessageResult,
  participantId,
} from "./contracts.ts";
import { resolveThreadHome } from "./HomeRegistrar.ts";
import { isRegisteredHumanPerson, listRegisteredHumanPersonIds } from "./HumanPersonRegistry.ts";
import { A2ALedger, type A2ALedgerError } from "./LedgerService.ts";

export class A2ASenderNotJoinedError extends Schema.TaggedErrorClass<A2ASenderNotJoinedError>()(
  "A2ASenderNotJoinedError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Cross-agent messaging is unavailable for native thread ${this.threadId} because it has no registered home squadron. No native user-created-thread hook consumes the internal registrar at this head. The sanctioned future production path is the A6 creation wrapper; controlled tests may seed membership directly. Stop this messaging attempt.`;
  }
}

export class A2AHomeMembershipStateError extends Schema.TaggedErrorClass<A2AHomeMembershipStateError>()(
  "A2AHomeMembershipStateError",
  {
    threadId: Schema.String,
    expectedSquadronId: Schema.String,
    expectedParticipantId: Schema.String,
    activeHomes: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const active = this.activeHomes.length === 0 ? "none" : this.activeHomes.join(", ");
    return `Thread ${this.threadId} has immutable home ${this.expectedSquadronId}:${this.expectedParticipantId}, but its active membership projection is ${active}. Repair the projection before retrying; do not register a new home.`;
  }
}

export class A2ASenderRetiredError extends Schema.TaggedErrorClass<A2ASenderRetiredError>()(
  "A2ASenderRetiredError",
  {
    threadId: Schema.String,
    squadronId: Schema.String,
    participantId: Schema.String,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} was retired from immutable home ${this.squadronId}:${this.participantId} by participant.left and cannot send cross-agent messages. Do not repair the projection or register another home; stop this messaging attempt.`;
  }
}

export class A2AParticipantNotFoundError extends Schema.TaggedErrorClass<A2AParticipantNotFoundError>()(
  "A2AParticipantNotFoundError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `Participant ${this.participantId} is not currently reachable. Call list_participants and choose an agent row with canReceiveMessage=true, or a human row with canOpenExchange=true to open an ask.`;
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

export class A2AParticipantArchivedError extends Schema.TaggedErrorClass<A2AParticipantArchivedError>()(
  "A2AParticipantArchivedError",
  {
    participantId: Schema.String,
    squadronId: Schema.String,
  },
) {
  override get message(): string {
    return `Participant ${this.participantId} is A2A-retired from immutable home ${this.squadronId} by participant.left and cannot receive new messages. Upstream thread unarchive does not revive A2A participation; choose an active participant or wait for a ratified re-entry policy.`;
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

export class A2AHumanAskOrReplyRequiredError extends Schema.TaggedErrorClass<A2AHumanAskOrReplyRequiredError>()(
  "A2AHumanAskOrReplyRequiredError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `A plain send to human participant ${this.participantId} is refused. To the human, use an ask with expect_reply=true, intent, and urgency=blocking|soon|fyi, or a reply with exchange_id. If nobody needs to act, say it in your own thread instead.`;
  }
}

export class A2AHumanFollowupNotAllowedError extends Schema.TaggedErrorClass<A2AHumanFollowupNotAllowedError>()(
  "A2AHumanFollowupNotAllowedError",
  { participantId: Schema.String },
) {
  override get message(): string {
    return `A follow-up to human participant ${this.participantId} is refused. To the human, use an ask with expect_reply=true, intent, and urgency=blocking|soon|fyi, or a reply with exchange_id; after an ask is open, wait for its reply, or clear_own_ask on the open exchange and re-ask with the combined content. If nobody needs to act, say it in your own thread instead.`;
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

export class A2ACrossSquadronReplyInvariantError extends Schema.TaggedErrorClass<A2ACrossSquadronReplyInvariantError>()(
  "A2ACrossSquadronReplyInvariantError",
  {
    exchangeId: Schema.String,
    exchangeSquadronId: Schema.String,
    senderSquadronId: Schema.String,
    replyPersisted: Schema.Boolean,
  },
) {
  override get message(): string {
    const replyState = this.replyPersisted
      ? "A durable reply is already persisted for this command under the cross-Squadron state; this replay sent nothing new."
      : "A cross-Squadron reply cannot record the required closure fact, so nothing was sent.";
    return `Exchange ${this.exchangeId} belongs to ${this.exchangeSquadronId}, but the replying sender's immutable home is ${this.senderSquadronId}. ${replyState} Report this invariant failure with the exchange and Squadron ids; do not retry send_message for this exchange.`;
  }
}

export class A2AClearOwnAskSenderMismatchError extends Schema.TaggedErrorClass<A2AClearOwnAskSenderMismatchError>()(
  "A2AClearOwnAskSenderMismatchError",
  {
    exchangeId: Schema.String,
    callerId: Schema.String,
    senderId: Schema.String,
  },
) {
  override get message(): string {
    return `Exchange ${this.exchangeId} was opened by ${this.senderId}, not ${this.callerId}. Only that sender may withdraw this exchange. Do not retry clear_own_ask for exchange ${this.exchangeId} from this thread; other exchanges are unaffected.`;
  }
}

export class A2AClearOwnAskAlreadyClosedError extends Schema.TaggedErrorClass<A2AClearOwnAskAlreadyClosedError>()(
  "A2AClearOwnAskAlreadyClosedError",
  { exchangeId: Schema.String },
) {
  override get message(): string {
    return `Exchange ${this.exchangeId} is already closed; clear_own_ask made no change.`;
  }
}

export class A2AClearOwnAskUnknownExchangeError extends Schema.TaggedErrorClass<A2AClearOwnAskUnknownExchangeError>()(
  "A2AClearOwnAskUnknownExchangeError",
  { exchangeId: Schema.String },
) {
  override get message(): string {
    return `Exchange ${this.exchangeId} does not exist in the messaging ledger; clear_own_ask made no change. There is no agent-facing own-open-asks read at this head, so use only an exchange_id retained from the original send_message result; do not retry this unknown id.`;
  }
}

export class A2AClearOwnAskCommandConflictError extends Schema.TaggedErrorClass<A2AClearOwnAskCommandConflictError>()(
  "A2AClearOwnAskCommandConflictError",
  { commandId: Schema.String, exchangeId: Schema.String },
) {
  override get message(): string {
    return `The client_request_id behind command ${this.commandId} is already bound to a different request. This clear_own_ask call did not close exchange ${this.exchangeId}. Reusing a client_request_id for the same clear replays its original success; retry this different request with a unique client_request_id.`;
  }
}

export type A2ASendError =
  | A2ALedgerError
  | Schema.SchemaError
  | SqlError
  | A2ASenderNotJoinedError
  | A2ASenderRetiredError
  | A2AHomeMembershipStateError
  | A2AParticipantNotFoundError
  | A2AAmbiguousParticipantError
  | A2AParticipantArchivedError
  | A2AIntentRequiredError
  | A2AUrgencyRequiredError
  | A2AUrgencyNotAcceptedError
  | A2AUrgencyRequiresExchangeError
  | A2AHumanAskOrReplyRequiredError
  | A2AHumanFollowupNotAllowedError
  | A2AExchangeNotOpenError
  | A2AExchangeAlreadyAnsweredError
  | A2ACrossSquadronReplyInvariantError
  | A2AExchangeParticipantMismatchError
  | A2AClearOwnAskSenderMismatchError
  | A2AClearOwnAskAlreadyClosedError
  | A2AClearOwnAskUnknownExchangeError
  | A2AClearOwnAskCommandConflictError;

interface MembershipRow {
  readonly squadron_id: string;
  readonly participant_id: string;
  readonly payload: string;
}

interface RetiredParticipantRow {
  readonly squadron_id: string;
}

interface ExchangeRow {
  readonly squadron_id: string;
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly status: "open" | "closed" | "dropped";
}

interface ExistingMessageRow {
  readonly squadron_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly exchange_id: string | null;
  readonly exchange_role: "none" | "ask" | "followup" | "reply" | "terminal_notice";
  readonly sent_seq: number;
}

interface ExistingSenderClearedRow {
  readonly created_at: string;
  readonly closure_kind: string | null;
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
  readonly clearOwnAsk: (input: ClearOwnAskInput) => Effect.Effect<ClearOwnAskResult, A2ASendError>;
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
          SELECT squadron_id, participant_id, payload
          FROM j5_a2a_squadron_membership
          ORDER BY squadron_id, participant_id
        `;
      });

      const retiredParticipantRows = Effect.fn("j5.a2a.send.retiredParticipantRows")(function* (
        id: ParticipantId,
      ) {
        return yield* sql<RetiredParticipantRow>`
          SELECT joined.squadron_id
          FROM j5_a2a_comm_event AS joined
          WHERE joined.kind = 'participant.joined'
            AND json_extract(joined.payload, '$.participant.kind') = 'agent'
            AND json_extract(joined.payload, '$.participant.id') = ${id}
            AND EXISTS (
              SELECT 1
              FROM j5_a2a_comm_event AS retirement
              WHERE retirement.squadron_id = joined.squadron_id
                AND retirement.seq > joined.seq
                AND retirement.kind = 'participant.left'
                AND json_extract(retirement.payload, '$.participant.kind') = 'agent'
                AND json_extract(retirement.payload, '$.participant.id') = ${id}
                AND json_extract(retirement.payload, '$.participant.threadId') =
                  json_extract(joined.payload, '$.participant.threadId')
            )
          ORDER BY joined.seq
          LIMIT 2
        `;
      });

      const senderMembership = Effect.fn("j5.a2a.send.senderMembership")(function* (
        threadId: ThreadId,
      ) {
        const resolution = yield* resolveThreadHome(sql, threadId).pipe(
          Effect.catchTag("A2AHomeNotFoundError", () =>
            Effect.fail(new A2ASenderNotJoinedError({ threadId })),
          ),
        );
        const matches = resolution.activeMemberships.filter(
          (membership) =>
            membership.squadronId === resolution.home.squadronId &&
            membership.participantId === resolution.home.participantId,
        );
        if (resolution.retired && resolution.activeMemberships.length === 0) {
          return yield* new A2ASenderRetiredError({
            threadId,
            squadronId: resolution.home.squadronId,
            participantId: resolution.home.participantId,
          });
        }
        if (
          resolution.retired ||
          resolution.activeMemberships.length !== 1 ||
          matches.length !== 1
        ) {
          return yield* new A2AHomeMembershipStateError({
            threadId,
            expectedSquadronId: resolution.home.squadronId,
            expectedParticipantId: resolution.home.participantId,
            activeHomes: resolution.activeMemberships.map(
              (membership) => `${membership.squadronId}:${membership.participantId}`,
            ),
          });
        }
        return resolution.home;
      });

      const participantMembership = Effect.fn("j5.a2a.send.participantMembership")(function* (
        id: ParticipantId,
        senderSquadronId: SquadronId,
      ) {
        if (isHumanParticipantId(id)) {
          if (!(yield* isRegisteredHumanPerson(sql, id))) {
            return yield* new A2AParticipantNotFoundError({ participantId: id });
          }
          return {
            squadronId: senderSquadronId,
            participant: { kind: "human" as const, id },
          };
        }
        const matches = (yield* membershipRows()).filter((row) => row.participant_id === id);
        if (matches.length === 0) {
          const retired = yield* retiredParticipantRows(id);
          if (retired[0] === undefined) {
            return yield* new A2AParticipantNotFoundError({ participantId: id });
          }
          if (retired.length > 1) {
            return yield* new A2AAmbiguousParticipantError({ participantId: id });
          }
          return yield* new A2AParticipantArchivedError({
            participantId: id,
            squadronId: retired[0].squadron_id,
          });
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
          const people = yield* listRegisteredHumanPersonIds(sql);
          const membershipCounts = new Map<string, number>();
          for (const row of rows) {
            membershipCounts.set(
              row.participant_id,
              (membershipCounts.get(row.participant_id) ?? 0) + 1,
            );
          }
          const agents = yield* Effect.forEach(
            rows,
            (row) =>
              decodeParticipant(row.payload).pipe(
                Effect.map((participant) => {
                  const id = participantId(participant);
                  const addressable = membershipCounts.get(id) === 1;
                  return {
                    squadronId: SquadronId.make(row.squadron_id),
                    participantId: id,
                    participant,
                    canReceiveMessage: addressable,
                    canOpenExchange: addressable,
                    acceptsUrgency: false,
                  };
                }),
              ),
            { concurrency: 1 },
          );
          return [
            ...agents,
            ...people.map(
              (personId) =>
                ({
                  squadronId: sender.squadronId,
                  participantId: personId,
                  participant: { kind: "human", id: personId },
                  canReceiveMessage: false,
                  canOpenExchange: true,
                  acceptsUrgency: true,
                }) satisfies ParticipantDirectoryRow,
            ),
          ];
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
        if (isCrossSquadronReply) {
          return yield* new A2ACrossSquadronReplyInvariantError({
            exchangeId: row.exchange_id!,
            exchangeSquadronId: exchange[0]!.squadron_id,
            senderSquadronId: row.squadron_id,
            replyPersisted: true,
          });
        }
        return {
          messageId,
          exchangeId: row.exchange_id === null ? null : ExchangeId.make(row.exchange_id),
          exchangeState:
            row.exchange_role === "none"
              ? ("none" as const)
              : row.exchange_role !== "reply"
                ? ("open" as const)
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
          if (
            receiver.participant.kind === "human" &&
            input.expectReply !== true &&
            input.exchangeId === undefined
          ) {
            return yield* new A2AHumanAskOrReplyRequiredError({ participantId: receiverId });
          }
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
              if (exchange.squadron_id !== sender.squadronId) {
                return yield* new A2ACrossSquadronReplyInvariantError({
                  exchangeId,
                  exchangeSquadronId: exchange.squadron_id,
                  senderSquadronId: sender.squadronId,
                  replyPersisted: false,
                });
              }
              const acceptedReplies = yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count
                FROM j5_a2a_delivery
                WHERE exchange_id = ${exchangeId} AND exchange_role = 'reply'
              `;
              if ((acceptedReplies[0]?.count ?? 0) > 0) {
                return yield* new A2AExchangeAlreadyAnsweredError({ exchangeId });
              }
              exchangeRole = "reply";
              exchangeState = "closed";
              closeEvent = {
                kind: "exchange.closed",
                sender: sender.participantId,
                receiver: receiverId,
                exchangeId,
                correlationId: correlationIdFor(input.commandId),
                payload: { replyMessageId: messageId },
                createdAt: input.acceptedAt,
              };
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

          if (receiver.participant.kind === "human" && exchangeRole === "followup") {
            return yield* new A2AHumanFollowupNotAllowedError({ participantId: receiverId });
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

      const clearOwnAsk: A2ASendServiceShape["clearOwnAsk"] = (input) =>
        Effect.gen(function* () {
          const sender = yield* senderMembership(input.senderThreadId);
          const replay = yield* sql<ExistingSenderClearedRow>`
            SELECT
              created_at,
              json_extract(payload, '$.closureKind') AS closure_kind
            FROM j5_a2a_comm_event
            WHERE command_id = ${input.commandId}
              AND kind = 'exchange.closed'
              AND sender = ${sender.participantId}
              AND exchange_id = ${input.exchangeId}
            LIMIT 2
          `;
          if (replay.length === 1 && replay[0]!.closure_kind === "sender-cleared") {
            return {
              exchangeId: input.exchangeId,
              closureKind: "sender-cleared",
              closedAt: replay[0]!.created_at,
            } satisfies ClearOwnAskResult;
          }

          const rows = yield* sql<ExchangeRow>`
            SELECT squadron_id, exchange_id, sender_id, receiver_id, status
            FROM j5_a2a_exchange
            WHERE exchange_id = ${input.exchangeId}
            LIMIT 2
          `;
          const exchange = rows.length === 1 ? rows[0] : undefined;
          if (exchange === undefined) {
            return yield* new A2AClearOwnAskUnknownExchangeError({
              exchangeId: input.exchangeId,
            });
          }
          if (exchange.sender_id !== sender.participantId) {
            return yield* new A2AClearOwnAskSenderMismatchError({
              exchangeId: input.exchangeId,
              callerId: sender.participantId,
              senderId: exchange.sender_id,
            });
          }
          if (exchange.status !== "open") {
            return yield* new A2AClearOwnAskAlreadyClosedError({
              exchangeId: input.exchangeId,
            });
          }

          const result = yield* ledger.append({
            commandId: input.commandId,
            squadronId: SquadronId.make(exchange.squadron_id),
            acceptedAt: input.acceptedAt,
            event: {
              kind: "exchange.closed",
              sender: sender.participantId,
              receiver: ParticipantId.make(exchange.receiver_id),
              exchangeId: input.exchangeId,
              correlationId: correlationIdFor(input.commandId),
              payload: { closureKind: "sender-cleared" },
              createdAt: input.acceptedAt,
            },
          });
          const eventMatchesClear =
            result.event.kind === "exchange.closed" &&
            result.event.exchangeId === input.exchangeId &&
            result.event.sender === sender.participantId &&
            typeof result.event.payload === "object" &&
            result.event.payload !== null &&
            "closureKind" in result.event.payload &&
            result.event.payload.closureKind === "sender-cleared";
          const clearResult = {
            exchangeId: input.exchangeId,
            closureKind: "sender-cleared" as const,
            closedAt: result.event.createdAt,
          } satisfies ClearOwnAskResult;
          if (!result.committed && eventMatchesClear) return clearResult;
          if (!result.committed || !eventMatchesClear) {
            return yield* new A2AClearOwnAskCommandConflictError({
              commandId: input.commandId,
              exchangeId: input.exchangeId,
            });
          }
          return clearResult;
        });

      return A2ASendService.of({ send, clearOwnAsk, listParticipants });
    }),
  );
