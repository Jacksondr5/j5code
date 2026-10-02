import {
  type CommEvent,
  CorrelationId,
  type ExchangeDropDisposition,
  type ExchangeDroppedPayload,
  ExchangeId,
  isHumanParticipantId,
  LIFECYCLE_PARTICIPANT_ID,
  LedgerMessageId,
  ParticipantId,
  SquadronId,
} from "./contracts.ts";

/**
 * The notices a sender gets when a message to a peer server will not arrive:
 * the server refused it, or the peer was removed while it waited. Each message
 * gets one notice. A refused ask's notice also says its Exchange has ended,
 * and the Exchange is dropped as refused; an open Exchange with a removed peer
 * is dropped with a drop notice. Either way the party here owes nothing.
 */

const stablePart = (value: string) => encodeURIComponent(value);

/** Only an agent or a person on this server can be told; platform and machine senders cannot. */
export const canBeNotified = (participantId: string) =>
  participantId.startsWith("agent:") || isHumanParticipantId(ParticipantId.make(participantId));

export const formatNotDeliveredNotice = (input: {
  readonly receiverId: string;
  readonly serverName: string;
  readonly reason: string;
  /** Set for an ask: the Exchange it opened has ended. */
  readonly exchangeId?: string;
}) =>
  [
    "[Cross-agent messaging system notice: message not delivered]",
    `Your message to ${input.receiverId} on ${input.serverName} was not delivered: ${input.reason}`,
    ...(input.exchangeId === undefined
      ? []
      : [
          "The exchange is closed; nothing is owed and nothing will answer it.",
          `Facts: exchangeId=${input.exchangeId}; replyRequired=false; retryAllowed=false; replacementRequired=false.`,
        ]),
    "This is a platform-authored notice, not a peer reply.",
  ].join("\n\n");

export const formatPeerDropNotice = (input: {
  readonly exchangeId: string;
  readonly disposition: ExchangeDropDisposition;
  /** Why it ended, completing "Exchange X ended because …". */
  readonly because: string;
}) =>
  [
    "[Cross-agent messaging system notice: exchange dropped]",
    `Exchange ${input.exchangeId} ended because ${input.because} (${input.disposition}).`,
    input.disposition === "receiver-retired"
      ? "The receiver will not answer this Exchange. Do not retry it."
      : "The asker is gone. Your reply obligation has ended; do not send a replacement reply.",
    "Facts: replyRequired=false; retryAllowed=false; replacementRequired=false.",
    "This is a platform-authored terminal notice, not a peer reply.",
  ].join("\n\n");

/** The message a notice is about, as its delivery row records it. */
export interface UndeliveredMessage {
  readonly squadron_id: string;
  readonly message_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
}

const notDeliveredKey = (message: UndeliveredMessage) =>
  `${stablePart(message.squadron_id)}:${stablePart(message.message_id)}`;

/** The one notice a message can get, so a later step can see it was already told. */
export const notDeliveredNoticeMessageId = (message: UndeliveredMessage) =>
  LedgerMessageId.make(`message:j5:a2a:not-delivered:${notDeliveredKey(message)}`);

/** A not-delivered notice to the message's sender, in the sender's Squadron. */
export const notDeliveredNoticeEvent = (input: {
  readonly message: UndeliveredMessage;
  readonly serverName: string;
  readonly reason: string;
  readonly createdAt: string;
}): CommEvent => {
  const key = notDeliveredKey(input.message);
  return {
    kind: "message.sent",
    sender: LIFECYCLE_PARTICIPANT_ID,
    receiver: ParticipantId.make(input.message.sender_id),
    exchangeId: null,
    correlationId: CorrelationId.make(`correlation:j5:a2a:not-delivered:${key}`),
    payload: {
      messageId: notDeliveredNoticeMessageId(input.message),
      text: formatNotDeliveredNotice({
        receiverId: input.message.receiver_id,
        serverName: input.serverName,
        reason: input.reason,
      }),
      originSquadronId: SquadronId.make(input.message.squadron_id),
      receiverSquadronId: SquadronId.make(input.message.squadron_id),
      exchangeRole: "none",
      envelopeChannel: "lifecycle_notice",
    },
    createdAt: input.createdAt,
  };
};

/** The open Exchange a drop ends, and the party on this server who is told. */
export interface DroppedExchange {
  readonly squadron_id: string;
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
}

/**
 * The drop of an open Exchange whose other party is on a peer server, and its
 * one notice to the party here, which closes the Exchange for it.
 */
export const peerDropEvents = (input: {
  readonly exchange: DroppedExchange;
  readonly disposition: ExchangeDropDisposition;
  /** What ended it, naming the party on the peer server. */
  readonly cause: ExchangeDroppedPayload["cause"];
  /** The local party's Squadron, where the notice is delivered. */
  readonly localSquadronId: string;
  readonly noticeText: string;
  readonly createdAt: string;
}): ReadonlyArray<CommEvent> => {
  const exchangeId = ExchangeId.make(input.exchange.exchange_id);
  const key = `${stablePart(input.exchange.squadron_id)}:${stablePart(input.exchange.exchange_id)}:${input.cause.kind}`;
  const messageId = LedgerMessageId.make(`message:j5:a2a:peer-drop:${key}`);
  const correlationId = CorrelationId.make(`correlation:j5:a2a:peer-drop:${key}`);
  const localParty =
    input.disposition === "receiver-retired"
      ? input.exchange.sender_id
      : input.exchange.receiver_id;
  return [
    {
      kind: "exchange.dropped",
      sender: ParticipantId.make(input.exchange.sender_id),
      receiver: ParticipantId.make(input.exchange.receiver_id),
      exchangeId,
      correlationId,
      payload: {
        disposition: input.disposition,
        cause: input.cause,
        facts: { replyRequired: false, retryAllowed: false, replacementRequired: false },
        noticeMessageId: messageId,
      } satisfies ExchangeDroppedPayload,
      createdAt: input.createdAt,
    },
    ...(canBeNotified(localParty)
      ? [
          {
            kind: "message.sent",
            sender: LIFECYCLE_PARTICIPANT_ID,
            receiver: ParticipantId.make(localParty),
            exchangeId,
            correlationId,
            payload: {
              messageId,
              text: input.noticeText,
              originSquadronId: SquadronId.make(input.exchange.squadron_id),
              receiverSquadronId: SquadronId.make(input.localSquadronId),
              exchangeRole: "terminal_notice",
              envelopeChannel: "lifecycle_notice",
            },
            createdAt: input.createdAt,
          } satisfies CommEvent,
        ]
      : []),
  ];
};
