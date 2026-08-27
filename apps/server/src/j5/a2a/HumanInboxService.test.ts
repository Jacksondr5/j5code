import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { A2ADeliveryWorker, manualLayer as deliveryWorkerLayer } from "./DeliveryWorker.ts";
import {
  A2ADeliveryTransport,
  type A2ADeliveryTransportShape,
  type AgentDeliveryInput,
} from "./DeliveryTransport.ts";
import { A2AHumanInbox, layer as humanInboxLayer } from "./HumanInboxService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import {
  CommCommandId,
  SquadronId,
  ParticipantId,
  type AgentParticipant,
  type HumanParticipant,
} from "./contracts.ts";

const firstPerson: HumanParticipant = {
  kind: "human",
  id: ParticipantId.make("human:person-one"),
};
const secondPerson: HumanParticipant = {
  kind: "human",
  id: ParticipantId.make("human:person-two"),
};

const makeTestLayer = (deliveries: Ref.Ref<ReadonlyArray<AgentDeliveryInput>>) => {
  const database = NodeSqliteClient.layerMemory();
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const inbox = humanInboxLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const transport = Layer.succeed(
    A2ADeliveryTransport,
    A2ADeliveryTransport.of({
      deliverAgent: (input) => Ref.update(deliveries, (current) => [...current, input]),
      deliverHuman: () => Effect.void,
    } satisfies A2ADeliveryTransportShape),
  );
  const worker = deliveryWorkerLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(transport),
  );
  return Layer.mergeAll(database, ledger, send, inbox, worker);
};

it.effect(
  "ranks open cross-Squadron exchanges and projects a second person's answer into A4-owned history",
  () =>
    Effect.gen(function* () {
      const deliveries = yield* Ref.make<ReadonlyArray<AgentDeliveryInput>>([]);
      yield* Effect.gen(function* () {
        yield* runJ5A2AMigrations();
        const ledger = yield* A2ALedger;
        const send = yield* A2ASendService;
        const inbox = yield* A2AHumanInbox;
        const worker = yield* A2ADeliveryWorker;
        const sql = yield* SqlClient.SqlClient;

        const open = Effect.fn("test.j5.a2a.humanInbox.open")(function* (input: {
          readonly suffix: string;
          readonly person: HumanParticipant;
          readonly intent: string;
          readonly urgency: "blocking" | "soon" | "fyi";
          readonly openedAt: string;
        }) {
          const squadronId = SquadronId.make(`squadron:human-inbox:${input.suffix}`);
          const agent: AgentParticipant = {
            kind: "agent",
            id: ParticipantId.make(`agent:human-inbox:${input.suffix}`),
            threadId: ThreadId.make(`thread:human-inbox:${input.suffix}`),
          };
          yield* ledger.createSquadron({
            squadron: {
              id: squadronId,
              name: `Squadron ${input.suffix}`,
              createdAt: input.openedAt,
            },
          });
          yield* ledger.appendEvents({
            commandId: CommCommandId.make(`command:human-inbox:join:${input.suffix}`),
            squadronId,
            acceptedAt: input.openedAt,
            events: [agent, input.person].map((participant) => ({
              kind: "participant.joined" as const,
              sender: null,
              receiver: participant.id,
              exchangeId: null,
              correlationId: null,
              payload: { participant },
              createdAt: input.openedAt,
            })),
          });
          const sent = yield* send.send({
            commandId: CommCommandId.make(`command:human-inbox:ask:${input.suffix}`),
            senderThreadId: agent.threadId,
            to: input.person.id,
            message: `Question ${input.suffix}`,
            expectReply: true,
            intent: input.intent,
            urgency: input.urgency,
            acceptedAt: input.openedAt,
          });
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
              status
            )
            SELECT
              exchange.receiver_id,
              exchange.squadron_id,
              exchange.exchange_id,
              exchange.sender_id,
              exchange.intent,
              exchange.urgency,
              delivery.message_id,
              delivery.message_text,
              exchange.opened_seq,
              exchange.created_at,
              'open'
            FROM j5_a2a_exchange AS exchange
            JOIN j5_a2a_delivery AS delivery
              ON delivery.squadron_id = exchange.squadron_id
             AND delivery.exchange_id = exchange.exchange_id
             AND delivery.exchange_role = 'ask'
            WHERE exchange.squadron_id = ${squadronId}
              AND exchange.exchange_id = ${sent.exchangeId}
          `;
          return { agent, squadronId, exchangeId: sent.exchangeId! };
        });

        yield* open({
          suffix: "fyi-old",
          person: firstPerson,
          intent: "Old FYI persists",
          urgency: "fyi",
          openedAt: "2020-01-01T00:00:00.000Z",
        });
        yield* open({
          suffix: "soon",
          person: firstPerson,
          intent: "Soon request",
          urgency: "soon",
          openedAt: "2026-08-23T11:00:00.000Z",
        });
        yield* open({
          suffix: "blocking-old",
          person: firstPerson,
          intent: "Older blocking request",
          urgency: "blocking",
          openedAt: "2026-08-22T11:00:00.000Z",
        });
        yield* open({
          suffix: "blocking-new",
          person: firstPerson,
          intent: "Newer blocking request",
          urgency: "blocking",
          openedAt: "2026-08-23T12:00:00.000Z",
        });
        const second = yield* open({
          suffix: "second-person",
          person: secondPerson,
          intent: "Second-person roundtrip",
          urgency: "blocking",
          openedAt: "2026-08-23T13:00:00.000Z",
        });

        const firstInbox = yield* inbox.list(firstPerson.id);
        assert.deepStrictEqual(
          firstInbox.map((item) => item.intent),
          ["Older blocking request", "Newer blocking request", "Soon request", "Old FYI persists"],
        );
        assert.deepStrictEqual(new Set(firstInbox.map((item) => item.squadronId)).size, 4);
        assert.deepStrictEqual(
          (yield* inbox.list(secondPerson.id)).map((item) => item.intent),
          ["Second-person roundtrip"],
        );
        const retiredGlobal = yield* Effect.flip(inbox.list(ParticipantId.make("human:global")));
        assert.equal(retiredGlobal._tag, "A2AHumanPersonIdError");

        const exactAnswer = "  First line\nSecond line  ";
        const answerCommand = {
          commandId: CommCommandId.make("command:human-inbox:answer:second-person"),
          personId: secondPerson.id,
          exchangeId: second.exchangeId,
          message: exactAnswer,
          acceptedAt: "2026-08-23T14:00:00.000Z",
        } as const;
        const answered = yield* inbox.answer(answerCommand);
        const replayed = yield* inbox.answer(answerCommand);
        yield* worker.drain;

        assert.equal(answered.exchangeState, "closed");
        assert.deepStrictEqual(replayed, answered);
        assert.deepStrictEqual(yield* inbox.list(secondPerson.id), []);
        assert.lengthOf(yield* inbox.list(firstPerson.id), 4);
        const answerDeliveries = (yield* Ref.get(deliveries)).filter(
          (delivery) => delivery.messageId === answered.messageId,
        );
        assert.lengthOf(answerDeliveries, 1);
        assert.equal(answerDeliveries[0]?.senderId, secondPerson.id);
        assert.equal(answerDeliveries[0]?.receiverId, second.agent.id);
        assert.equal(answerDeliveries[0]?.message, exactAnswer);

        const durable = yield* sql<{
          readonly message_text: string;
          readonly status: string;
          readonly terminal_disposition: string | null;
        }>`
          SELECT delivery.message_text, inbox.status, inbox.terminal_disposition
          FROM j5_a2a_delivery AS delivery
          JOIN j5_a2a_human_inbox AS inbox
            ON inbox.squadron_id = delivery.squadron_id
           AND inbox.exchange_id = delivery.exchange_id
          WHERE delivery.message_id = ${answered.messageId}
        `;
        assert.deepStrictEqual(durable, [
          {
            message_text: exactAnswer,
            status: "answered",
            terminal_disposition: "answered",
          },
        ]);
        const answerBytes = yield* sql<{
          readonly actual: string;
          readonly expected: string;
        }>`
          SELECT hex(message_text) AS actual, hex(${exactAnswer}) AS expected
          FROM j5_a2a_delivery
          WHERE message_id = ${answered.messageId}
        `;
        assert.lengthOf(answerBytes, 1);
        assert.equal(answerBytes[0]?.actual, answerBytes[0]?.expected);
        const answerEvents = yield* sql<{
          readonly kind: string;
          readonly payload: string;
          readonly receiver: string;
          readonly sender: string;
        }>`
          SELECT kind, sender, receiver, payload
          FROM j5_a2a_comm_event
          WHERE command_id = ${answerCommand.commandId}
          ORDER BY seq
        `;
        assert.deepStrictEqual(
          answerEvents.map((event) => ({ ...event, payload: JSON.parse(event.payload) })),
          [
            {
              kind: "message.sent",
              sender: secondPerson.id,
              receiver: second.agent.id,
              payload: {
                messageId: answered.messageId,
                text: exactAnswer,
                originSquadronId: second.squadronId,
                receiverSquadronId: second.squadronId,
                exchangeRole: "reply",
                envelopeChannel: "peer",
              },
            },
            {
              kind: "exchange.closed",
              sender: secondPerson.id,
              receiver: second.agent.id,
              payload: { replyMessageId: answered.messageId },
            },
          ],
        );
      }).pipe(Effect.provide(makeTestLayer(deliveries)));
    }),
);
