import { ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Identifier = Schema.String.check(Schema.isNonEmpty());
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const EpicId = Identifier.pipe(Schema.brand("J5A2AEpicId"));
export type EpicId = typeof EpicId.Type;

export const ExchangeId = Identifier.pipe(Schema.brand("J5A2AExchangeId"));
export type ExchangeId = typeof ExchangeId.Type;

export const CorrelationId = Identifier.pipe(Schema.brand("J5A2ACorrelationId"));
export type CorrelationId = typeof CorrelationId.Type;

export const ParticipantId = Identifier.pipe(Schema.brand("J5A2AParticipantId"));
export type ParticipantId = typeof ParticipantId.Type;

export const CommCommandId = Identifier.pipe(Schema.brand("J5A2ACommCommandId"));
export type CommCommandId = typeof CommCommandId.Type;

export const GLOBAL_HUMAN_PARTICIPANT_ID = ParticipantId.make("human:global");

export const AgentParticipant = Schema.Struct({
  kind: Schema.Literal("agent"),
  id: ParticipantId,
  threadId: ThreadId,
});
export type AgentParticipant = typeof AgentParticipant.Type;

/**
 * There is exactly one human participant for the host. Provider-native
 * ExecutionNodes cannot satisfy this closed participant union because they do
 * not own an addressable T3 thread.
 */
export const HumanParticipant = Schema.Struct({
  kind: Schema.Literal("human"),
});
export type HumanParticipant = typeof HumanParticipant.Type;

export const Participant = Schema.Union([AgentParticipant, HumanParticipant]);
export type Participant = typeof Participant.Type;

export const participantId = (participant: Participant): ParticipantId =>
  participant.kind === "human" ? GLOBAL_HUMAN_PARTICIPANT_ID : participant.id;

export const Epic = Schema.Struct({
  id: EpicId,
  name: Identifier,
  createdAt: Schema.String,
});
export type Epic = typeof Epic.Type;

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
    originEpicId: EpicId,
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
  epicId: EpicId,
} as const;

export const StoredCommEvent = Schema.Union([
  Schema.Struct({ ...storedFields, ...NonMembershipCommEvent.fields }),
  Schema.Struct({ ...storedFields, ...MessageReceivedCommEvent.fields }),
  Schema.Struct({ ...storedFields, ...ParticipantJoinedCommEvent.fields }),
  Schema.Struct({ ...storedFields, ...ParticipantLeftCommEvent.fields }),
]);
export type StoredCommEvent = typeof StoredCommEvent.Type;

export const CreateEpicCommand = Schema.Struct({
  epic: Epic,
});
export type CreateEpicCommand = typeof CreateEpicCommand.Type;

export const AppendCommEventCommand = Schema.Struct({
  commandId: CommCommandId,
  epicId: EpicId,
  acceptedAt: Schema.String,
  event: CommEvent,
});
export type AppendCommEventCommand = typeof AppendCommEventCommand.Type;

export const CommCommandReceipt = Schema.Struct({
  commandId: CommCommandId,
  epicId: EpicId,
  commandType: Schema.Literal("comm.append"),
  acceptedAt: Schema.String,
  resultSeq: PositiveInt,
});
export type CommCommandReceipt = typeof CommCommandReceipt.Type;

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
  epicId: EpicId,
  participant: Participant,
  joinedSeq: PositiveInt,
  updatedSeq: PositiveInt,
});
export type Membership = typeof Membership.Type;
