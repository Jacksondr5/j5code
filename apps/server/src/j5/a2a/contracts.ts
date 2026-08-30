import { ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Identifier = Schema.String.check(Schema.isNonEmpty());
const SquadronName = Schema.String.check(
  Schema.makeFilter((name) => name.trim().length > 0 || "Squadron name must not be blank."),
);
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const SquadronId = Identifier.pipe(Schema.brand("J5A2ASquadronId"));
export type SquadronId = typeof SquadronId.Type;

export const ExchangeId = Identifier.pipe(Schema.brand("J5A2AExchangeId"));
export type ExchangeId = typeof ExchangeId.Type;

export const CorrelationId = Identifier.pipe(Schema.brand("J5A2ACorrelationId"));
export type CorrelationId = typeof CorrelationId.Type;

export const ParticipantId = Identifier.pipe(Schema.brand("J5A2AParticipantId"));
export type ParticipantId = typeof ParticipantId.Type;

export const CommCommandId = Identifier.pipe(Schema.brand("J5A2ACommCommandId"));
export type CommCommandId = typeof CommCommandId.Type;

export const LedgerMessageId = Identifier.pipe(Schema.brand("J5A2ALedgerMessageId"));
export type LedgerMessageId = typeof LedgerMessageId.Type;

export const Urgency = Schema.Literals(["blocking", "soon", "fyi"]);
export type Urgency = typeof Urgency.Type;

export const DeliveryEnvelopeChannel = Schema.Literals(["peer", "silence_notice"]);
export type DeliveryEnvelopeChannel = typeof DeliveryEnvelopeChannel.Type;

export const SILENCE_DETECTOR_PARTICIPANT_ID = ParticipantId.make("platform:silence-detector");

export const isHumanParticipantId = (id: ParticipantId): boolean =>
  id.startsWith("human:") && id.length > "human:".length;

export const isDurableHumanParticipantId = (id: ParticipantId): boolean =>
  isHumanParticipantId(id) && id !== "human:global";

export const AgentParticipant = Schema.Struct({
  kind: Schema.Literal("agent"),
  id: ParticipantId,
  threadId: ThreadId,
});
export type AgentParticipant = typeof AgentParticipant.Type;

export const HumanParticipant = Schema.Struct({
  kind: Schema.Literal("human"),
  id: ParticipantId.pipe(
    Schema.check(
      Schema.makeFilter(isDurableHumanParticipantId, {
        message: "A human participant id must use the durable human:<person-id> namespace.",
      }),
    ),
  ),
});
export type HumanParticipant = typeof HumanParticipant.Type;

export const Participant = Schema.Union([AgentParticipant, HumanParticipant]);
export type Participant = typeof Participant.Type;

export const participantId = (participant: Participant): ParticipantId => participant.id;

export const Squadron = Schema.Struct({
  id: SquadronId,
  name: SquadronName,
  createdAt: Schema.String,
});
export type Squadron = typeof Squadron.Type;

export const CommEventKind = Schema.Literals([
  "exchange.opened",
  "message.sent",
  "message.received",
  "message.delivered",
  "message.delivery_failed",
  "exchange.closed",
  "silence.notice",
  "participant.joined",
  "participant.left",
]);
export type CommEventKind = typeof CommEventKind.Type;

const NonMembershipEventKind = Schema.Literals([
  "exchange.opened",
  "message.sent",
  "message.delivered",
  "message.delivery_failed",
  "exchange.closed",
  "silence.notice",
]);

const eventAddressFields = {
  sender: Schema.NullOr(ParticipantId),
  receiver: Schema.NullOr(ParticipantId),
  exchangeId: Schema.NullOr(ExchangeId),
  correlationId: Schema.NullOr(CorrelationId),
  createdAt: Schema.String,
} as const;

const NonMembershipCommEvent = Schema.Struct({
  ...eventAddressFields,
  kind: NonMembershipEventKind,
  payload: Schema.Json,
});

const MessageReceivedCommEvent = Schema.Struct({
  ...eventAddressFields,
  kind: Schema.Literal("message.received"),
  correlationId: CorrelationId,
  payload: Schema.Struct({
    originSquadronId: SquadronId,
    message: Schema.Json,
  }),
});

const ParticipantJoinedCommEvent = Schema.Struct({
  ...eventAddressFields,
  kind: Schema.Literal("participant.joined"),
  payload: Schema.Struct({ participant: Participant }),
});

const ParticipantLeftCommEvent = Schema.Struct({
  ...eventAddressFields,
  kind: Schema.Literal("participant.left"),
  payload: Schema.Struct({ participant: Participant }),
});

export const CommEvent = Schema.Union([
  NonMembershipCommEvent,
  MessageReceivedCommEvent,
  ParticipantJoinedCommEvent,
  ParticipantLeftCommEvent,
]);
export type CommEvent = typeof CommEvent.Type;

const storedFields = {
  seq: PositiveInt,
  squadronId: SquadronId,
} as const;

export const StoredCommEvent = Schema.Union([
  Schema.Struct({ ...storedFields, ...NonMembershipCommEvent.fields }),
  Schema.Struct({ ...storedFields, ...MessageReceivedCommEvent.fields }),
  Schema.Struct({ ...storedFields, ...ParticipantJoinedCommEvent.fields }),
  Schema.Struct({ ...storedFields, ...ParticipantLeftCommEvent.fields }),
]);
export type StoredCommEvent = typeof StoredCommEvent.Type;

export const CreateSquadronCommand = Schema.Struct({
  squadron: Squadron,
});
export type CreateSquadronCommand = typeof CreateSquadronCommand.Type;

export const AppendCommEventCommand = Schema.Struct({
  commandId: CommCommandId,
  squadronId: SquadronId,
  acceptedAt: Schema.String,
  event: CommEvent,
});
export type AppendCommEventCommand = typeof AppendCommEventCommand.Type;

export const CommCommandReceipt = Schema.Struct({
  commandId: CommCommandId,
  squadronId: SquadronId,
  commandType: Schema.Literal("comm.append"),
  acceptedAt: Schema.String,
  resultSeq: PositiveInt,
});
export type CommCommandReceipt = typeof CommCommandReceipt.Type;

export const AppendCommEventsCommand = Schema.Struct({
  commandId: CommCommandId,
  squadronId: SquadronId,
  acceptedAt: Schema.String,
  events: Schema.Array(CommEvent).pipe(Schema.check(Schema.isMinLength(1))),
});
export type AppendCommEventsCommand = typeof AppendCommEventsCommand.Type;

export const ExchangeOpenedPayload = Schema.Struct({
  intent: Schema.String.check(Schema.isNonEmpty()),
  urgency: Schema.NullOr(Urgency),
});
export type ExchangeOpenedPayload = typeof ExchangeOpenedPayload.Type;

export const MessageSentPayload = Schema.Struct({
  messageId: LedgerMessageId,
  text: Schema.String.check(Schema.isNonEmpty()),
  originSquadronId: SquadronId,
  receiverSquadronId: SquadronId,
  exchangeRole: Schema.Literals(["none", "ask", "followup", "reply"]),
  envelopeChannel: DeliveryEnvelopeChannel,
});
export type MessageSentPayload = typeof MessageSentPayload.Type;

export const MessageDeliveredPayload = Schema.Struct({
  messageId: LedgerMessageId,
  attempt: PositiveInt,
  channel: Schema.Literals(["agent", "human"]),
});
export type MessageDeliveredPayload = typeof MessageDeliveredPayload.Type;

export const MessageDeliveryFailedPayload = Schema.Struct({
  messageId: LedgerMessageId,
  attempt: PositiveInt,
  error: Schema.String.check(Schema.isNonEmpty()),
  nextAttemptAt: Schema.NullOr(Schema.String),
  alarmed: Schema.Boolean,
});
export type MessageDeliveryFailedPayload = typeof MessageDeliveryFailedPayload.Type;

export const ExchangeClosedPayload = Schema.Struct({
  replyMessageId: LedgerMessageId,
});
export type ExchangeClosedPayload = typeof ExchangeClosedPayload.Type;

export const SendMessageInput = Schema.Struct({
  commandId: CommCommandId,
  senderThreadId: ThreadId,
  to: ParticipantId,
  message: Schema.String.check(Schema.isNonEmpty()),
  expectReply: Schema.optional(Schema.Boolean),
  exchangeId: Schema.optional(ExchangeId),
  intent: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  urgency: Schema.optional(Urgency),
  acceptedAt: Schema.String,
});
export type SendMessageInput = typeof SendMessageInput.Type;

export const SendMessageResult = Schema.Struct({
  messageId: LedgerMessageId,
  exchangeId: Schema.NullOr(ExchangeId),
  exchangeState: Schema.Literals(["none", "open", "closing", "closed"]),
  joinedExistingExchange: Schema.Boolean,
  durableAtSeq: PositiveInt,
});
export type SendMessageResult = typeof SendMessageResult.Type;

export const ParticipantDirectoryRow = Schema.Struct({
  squadronId: SquadronId,
  participantId: ParticipantId,
  participant: Participant,
  canReceiveMessage: Schema.Boolean,
  canOpenExchange: Schema.Boolean,
  acceptsUrgency: Schema.Boolean,
});
export type ParticipantDirectoryRow = typeof ParticipantDirectoryRow.Type;

export const DeliveryAlarm = Schema.Struct({
  squadronId: SquadronId,
  messageId: LedgerMessageId,
  attempts: PositiveInt,
  lastError: Schema.String,
});
export type DeliveryAlarm = typeof DeliveryAlarm.Type;

export const DeliveryMilestone = Schema.Struct({
  squadronId: SquadronId,
  messageId: LedgerMessageId,
  state: Schema.Literals(["delivered", "retry_scheduled", "alarmed"]),
  attempt: PositiveInt,
});
export type DeliveryMilestone = typeof DeliveryMilestone.Type;

export const LedgerCursor = Schema.Struct({
  afterSeq: NonNegativeInt,
  snapshotEnd: Schema.optional(NonNegativeInt),
});
export type LedgerCursor = typeof LedgerCursor.Type;

/**
 * `snapshotEnd` freezes one finite read batch. Reaching it does not mean the
 * caller is caught up to events committed after that snapshot was captured.
 */
export const CommEventPage = Schema.Struct({
  events: Schema.Array(StoredCommEvent),
  nextCursor: Schema.Struct({
    afterSeq: NonNegativeInt,
    snapshotEnd: NonNegativeInt,
  }),
  complete: Schema.Boolean,
});
export type CommEventPage = typeof CommEventPage.Type;

export const Membership = Schema.Struct({
  squadronId: SquadronId,
  participant: Participant,
  joinedSeq: PositiveInt,
  updatedSeq: PositiveInt,
});
export type Membership = typeof Membership.Type;

export const HumanInboxItem = Schema.Struct({
  personId: ParticipantId,
  squadronId: SquadronId,
  squadronName: SquadronName,
  exchangeId: ExchangeId,
  senderId: ParticipantId,
  intent: Schema.String,
  urgency: Urgency,
  message: Schema.String,
  openedAt: Schema.String,
});
export type HumanInboxItem = typeof HumanInboxItem.Type;

export const AnswerHumanExchangeInput = Schema.Struct({
  commandId: CommCommandId,
  personId: ParticipantId,
  exchangeId: ExchangeId,
  message: Schema.String.check(Schema.isNonEmpty()),
  acceptedAt: Schema.String,
});
export type AnswerHumanExchangeInput = typeof AnswerHumanExchangeInput.Type;
