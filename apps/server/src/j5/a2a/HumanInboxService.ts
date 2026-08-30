import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  type AnswerHumanExchangeInput,
  CommCommandId,
  type CommEvent,
  CorrelationId,
  SquadronId,
  ExchangeId,
  type HumanInboxItem,
  isDurableHumanParticipantId,
  LedgerMessageId,
  ParticipantId,
  type SendMessageResult,
} from "./contracts.ts";
import { A2ALedger, type A2ALedgerError } from "./LedgerService.ts";
import {
  type A2ALocalOperatorNotFoundError,
  getLocalOperatorHumanPersonId,
  isRegisteredHumanPerson,
} from "./HumanPersonRegistry.ts";
import {
  A2AExchangeAlreadyAnsweredError,
  A2AExchangeNotOpenError,
  A2AParticipantNotFoundError,
} from "./SendService.ts";

export class A2AHumanPersonIdError extends Schema.TaggedErrorClass<A2AHumanPersonIdError>()(
  "A2AHumanPersonIdError",
  { personId: Schema.String },
) {
  override get message(): string {
    return `Person ${this.personId} is not a durable human:<person-id>. Select an explicit person-scoped inbox.`;
  }
}

export type A2AHumanInboxError =
  | A2ALedgerError
  | SqlError
  | A2ALocalOperatorNotFoundError
  | A2AHumanPersonIdError
  | A2AParticipantNotFoundError
  | A2AExchangeNotOpenError
  | A2AExchangeAlreadyAnsweredError;

interface InboxRow {
  readonly person_id: string;
  readonly squadron_id: string;
  readonly squadron_name: string;
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly intent: string;
  readonly urgency: "blocking" | "soon" | "fyi";
  readonly message: string;
  readonly opened_at: string;
}

interface ExchangeRow {
  readonly squadron_id: string;
  readonly exchange_id: string;
  readonly sender_id: string;
  readonly receiver_id: string;
  readonly status: "open" | "closed" | "dropped";
}

interface ExistingReplyRow {
  readonly squadron_id: string;
  readonly sent_seq: number;
}

const messageIdFor = (commandId: CommCommandId) =>
  LedgerMessageId.make(`message:j5:a2a:${encodeURIComponent(commandId)}`);

const correlationIdFor = (commandId: CommCommandId) =>
  CorrelationId.make(`correlation:j5:a2a:${encodeURIComponent(commandId)}`);

const assertPersonId = (personId: ParticipantId) =>
  isDurableHumanParticipantId(personId)
    ? Effect.void
    : Effect.fail(new A2AHumanPersonIdError({ personId }));

export interface A2AHumanInboxShape {
  readonly resolvePersonId: (
    personId?: ParticipantId,
  ) => Effect.Effect<ParticipantId, A2AHumanInboxError>;
  readonly list: (
    personId: ParticipantId,
  ) => Effect.Effect<ReadonlyArray<HumanInboxItem>, A2AHumanInboxError>;
  readonly answer: (
    input: AnswerHumanExchangeInput,
  ) => Effect.Effect<SendMessageResult, A2AHumanInboxError>;
}

export class A2AHumanInbox extends Context.Service<A2AHumanInbox, A2AHumanInboxShape>()(
  "t3/j5/a2a/HumanInboxService/A2AHumanInbox",
) {}

export const layer: Layer.Layer<A2AHumanInbox, never, A2ALedger | SqlClient.SqlClient> =
  Layer.effect(
    A2AHumanInbox,
    Effect.gen(function* () {
      const ledger = yield* A2ALedger;
      const sql = yield* SqlClient.SqlClient;

      const resolvePersonId: A2AHumanInboxShape["resolvePersonId"] = (personId) =>
        Effect.gen(function* () {
          if (personId === undefined) return yield* getLocalOperatorHumanPersonId(sql);
          yield* assertPersonId(personId);
          if (!(yield* isRegisteredHumanPerson(sql, personId))) {
            return yield* new A2AParticipantNotFoundError({ participantId: personId });
          }
          return personId;
        });

      const list: A2AHumanInboxShape["list"] = (personId) =>
        Effect.gen(function* () {
          yield* resolvePersonId(personId);
          const rows = yield* sql<InboxRow>`
            SELECT
              exchange.receiver_id AS person_id,
              exchange.squadron_id,
              squadron.name AS squadron_name,
              exchange.exchange_id,
              exchange.sender_id,
              exchange.intent,
              exchange.urgency,
              inbox.latest_message AS message,
              inbox.opened_at
            FROM j5_a2a_human_inbox AS inbox
            JOIN j5_a2a_squadron AS squadron ON squadron.id = inbox.squadron_id
            JOIN j5_a2a_exchange AS exchange
              ON exchange.squadron_id = inbox.squadron_id
             AND exchange.exchange_id = inbox.exchange_id
            WHERE inbox.status = 'open'
              AND exchange.status = 'open'
              AND inbox.person_id = ${personId}
            ORDER BY
              CASE inbox.urgency
                WHEN 'blocking' THEN 0
                WHEN 'soon' THEN 1
                WHEN 'fyi' THEN 2
              END,
              inbox.opened_at,
              inbox.squadron_id,
              inbox.exchange_id
          `;
          return rows.map(
            (row) =>
              ({
                personId: ParticipantId.make(row.person_id),
                squadronId: SquadronId.make(row.squadron_id),
                squadronName: row.squadron_name,
                exchangeId: ExchangeId.make(row.exchange_id),
                senderId: ParticipantId.make(row.sender_id),
                intent: row.intent,
                urgency: row.urgency,
                message: row.message,
                openedAt: row.opened_at,
              }) satisfies HumanInboxItem,
          );
        });

      const answer: A2AHumanInboxShape["answer"] = (input) =>
        Effect.gen(function* () {
          yield* assertPersonId(input.personId);
          if (!(yield* isRegisteredHumanPerson(sql, input.personId))) {
            return yield* new A2AParticipantNotFoundError({ participantId: input.personId });
          }
          const messageId = messageIdFor(input.commandId);
          const replay = yield* sql<ExistingReplyRow>`
            SELECT squadron_id, sent_seq
            FROM j5_a2a_delivery
            WHERE message_id = ${messageId}
              AND sender_id = ${input.personId}
              AND exchange_id = ${input.exchangeId}
              AND exchange_role = 'reply'
            LIMIT 2
          `;
          if (replay.length === 1) {
            return {
              messageId,
              exchangeId: input.exchangeId,
              exchangeState: "closed",
              joinedExistingExchange: false,
              durableAtSeq: replay[0]!.sent_seq,
            } satisfies SendMessageResult;
          }

          const exchanges = yield* sql<ExchangeRow>`
            SELECT squadron_id, exchange_id, sender_id, receiver_id, status
            FROM j5_a2a_exchange
            WHERE exchange_id = ${input.exchangeId}
              AND receiver_id = ${input.personId}
            LIMIT 2
          `;
          const exchange = exchanges.length === 1 ? exchanges[0] : undefined;
          if (exchange === undefined) {
            return yield* new A2AParticipantNotFoundError({ participantId: input.personId });
          }
          if (exchange.status !== "open") {
            return yield* new A2AExchangeNotOpenError({ exchangeId: input.exchangeId });
          }
          const acceptedReplies = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM j5_a2a_delivery
            WHERE exchange_id = ${input.exchangeId} AND exchange_role = 'reply'
          `;
          if ((acceptedReplies[0]?.count ?? 0) > 0) {
            return yield* new A2AExchangeAlreadyAnsweredError({ exchangeId: input.exchangeId });
          }

          const squadronId = SquadronId.make(exchange.squadron_id);
          const senderId = ParticipantId.make(exchange.sender_id);
          const correlationId = correlationIdFor(input.commandId);
          const events: ReadonlyArray<CommEvent> = [
            {
              kind: "message.sent",
              sender: input.personId,
              receiver: senderId,
              exchangeId: input.exchangeId,
              correlationId,
              payload: {
                messageId,
                text: input.message,
                originSquadronId: squadronId,
                receiverSquadronId: squadronId,
                exchangeRole: "reply",
                envelopeChannel: "peer",
              },
              createdAt: input.acceptedAt,
            },
            {
              kind: "exchange.closed",
              sender: input.personId,
              receiver: senderId,
              exchangeId: input.exchangeId,
              correlationId,
              payload: { replyMessageId: messageId },
              createdAt: input.acceptedAt,
            },
          ];
          const result = yield* ledger.appendEvents({
            commandId: input.commandId,
            squadronId,
            acceptedAt: input.acceptedAt,
            events,
          });
          const sent = result.events.find((event) => event.kind === "message.sent");
          if (sent === undefined) {
            return yield* new A2AParticipantNotFoundError({ participantId: input.personId });
          }
          return {
            messageId,
            exchangeId: input.exchangeId,
            exchangeState: "closed",
            joinedExistingExchange: false,
            durableAtSeq: sent.seq,
          } satisfies SendMessageResult;
        });

      return A2AHumanInbox.of({ resolvePersonId, list, answer });
    }),
  );
