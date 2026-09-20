import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  A2ADeliveryHooks,
  A2ADeliveryWorker,
  layerWithHooks as deliveryWorkerLayerWithHooks,
} from "./DeliveryWorker.ts";
import {
  A2ADeliveryTransport,
  type A2ADeliveryTransportShape,
  type AgentDeliveryInput,
} from "./DeliveryTransport.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import {
  PeerInboundService,
  layer as peerInboundLayer,
  type PeerInboundInput,
} from "./PeerInboundService.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import {
  CommCommandId,
  CorrelationId,
  ExchangeId,
  ParticipantId,
  SquadronId,
  type AgentParticipant,
} from "./contracts.ts";

const timestamp = "2026-09-16T12:00:00.000Z";
const homeEnvironment = "environment-home";
const homeSquadron = SquadronId.make("squadron:home-support");
const localSquadron = SquadronId.make("squadron:work-billing");
const triage: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:j5:a2a:thread:triage"),
  threadId: ThreadId.make("thread:triage"),
};
const remoteAsker = ParticipantId.make("agent:j5:a2a:thread:remote-asker");

const makeTestLayer = (delivered: Ref.Ref<Array<AgentDeliveryInput>>) => {
  const database = NodeSqliteClient.layerMemory();
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const inbound = peerInboundLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const transport: A2ADeliveryTransportShape = {
    cancelAgent: () => Effect.succeed("cancelled" as const),
    deliverAgent: (input) => Ref.update(delivered, (rows) => [...rows, input]),
    deliverHuman: () => Effect.void,
  };
  const transportLayer = Layer.succeed(A2ADeliveryTransport, A2ADeliveryTransport.of(transport));
  const worker = deliveryWorkerLayerWithHooks(false).pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(transportLayer),
    Layer.provide(
      Layer.succeed(
        A2ADeliveryHooks,
        A2ADeliveryHooks.of({ afterTransportSuccess: () => Effect.void }),
      ),
    ),
  );
  return Layer.mergeAll(database, ledger, send, inbound, worker);
};

const setup = Effect.fn("test.j5.a2a.peer.inbound.setup")(function* () {
  yield* runJ5A2AMigrations();
  const ledger = yield* A2ALedger;
  yield* ledger.createSquadron({
    squadron: { id: localSquadron, name: "Billing Migration", createdAt: timestamp },
  });
  yield* ledger.append({
    commandId: CommCommandId.make("command:peer-inbound:join:triage"),
    squadronId: localSquadron,
    acceptedAt: timestamp,
    event: {
      kind: "participant.joined",
      sender: null,
      receiver: triage.id,
      exchangeId: null,
      correlationId: null,
      payload: { participant: triage },
      createdAt: timestamp,
    },
  });
});

const ask: PeerInboundInput = {
  messageId: "message:j5:a2a:remote-ask",
  senderId: remoteAsker,
  receiverId: triage.id,
  exchangeId: "exchange:j5:a2a:remote-ask",
  correlationId: "correlation:j5:a2a:remote-ask",
  exchangeRole: "ask",
  envelopeChannel: "peer",
  text: "What is the incident status?",
  originSquadronId: homeSquadron,
  intent: "incident status",
  createdAt: timestamp,
  originEnvironmentId: homeEnvironment,
};
const { intent: _askIntent, ...askWithoutIntent } = ask;

it.effect(
  "records a peer's ask as a received row plus a local Exchange, delivers it naming the remote Squadron, and replays a retry",
  () =>
    Effect.gen(function* () {
      const delivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
      yield* Effect.gen(function* () {
        yield* setup();
        const inbound = yield* PeerInboundService;
        const worker = yield* A2ADeliveryWorker;
        const sql = yield* SqlClient.SqlClient;

        const first = yield* inbound.receive(ask);
        assert.isFalse(first.replay);
        const again = yield* inbound.receive(ask);
        assert.isTrue(again.replay);
        assert.equal(again.receivedSeq, first.receivedSeq);

        const rows = yield* sql<{
          readonly kind: string;
          readonly origin_environment: string | null;
        }>`
          SELECT kind, json_extract(payload, '$.originEnvironmentId') AS origin_environment
          FROM j5_a2a_comm_event
          WHERE squadron_id = ${localSquadron} AND kind IN ('exchange.opened', 'message.received')
          ORDER BY seq
        `;
        assert.deepStrictEqual(rows, [
          { kind: "exchange.opened", origin_environment: null },
          { kind: "message.received", origin_environment: homeEnvironment },
        ]);
        const exchanges = yield* sql<{
          readonly sender_id: string;
          readonly receiver_id: string;
          readonly status: string;
        }>`SELECT sender_id, receiver_id, status FROM j5_a2a_exchange WHERE exchange_id = ${ask.exchangeId}`;
        assert.deepStrictEqual(exchanges, [
          { sender_id: remoteAsker, receiver_id: triage.id, status: "open" },
        ]);
        const pending = yield* sql<{
          readonly status: string;
          readonly origin_squadron_id: string;
          readonly origin_environment_id: string;
        }>`SELECT status, origin_squadron_id, origin_environment_id FROM j5_a2a_delivery WHERE message_id = ${ask.messageId}`;
        assert.deepStrictEqual(pending, [
          {
            status: "pending",
            origin_squadron_id: homeSquadron,
            origin_environment_id: homeEnvironment,
          },
        ]);

        const milestone = yield* worker.runOnce;
        assert.equal(milestone?.state, "delivered");
        assert.equal(milestone?.squadronId, localSquadron);
        const attempts = yield* Ref.get(delivered);
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0]!.originSquadronId, homeSquadron, "the envelope names the origin");
        assert.equal(attempts[0]!.receiverSquadronId, localSquadron);
        assert.equal(attempts[0]!.senderId, remoteAsker);
        assert.equal(attempts[0]!.exchangeRole, "ask");
        assert.isNull(yield* worker.runOnce, "nothing else to deliver");

        const received = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM j5_a2a_comm_event
          WHERE squadron_id = ${localSquadron} AND kind = 'message.received'
        `;
        assert.deepStrictEqual(received, [{ count: 1 }], "the worker adds no second received row");
      }).pipe(Effect.provide(makeTestLayer(delivered)));
    }),
);

it.effect("lets the local agent reply to a peer's ask as an ordinary same-Squadron reply", () =>
  Effect.gen(function* () {
    const delivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
    yield* Effect.gen(function* () {
      yield* setup();
      const inbound = yield* PeerInboundService;
      const send = yield* A2ASendService;
      const sql = yield* SqlClient.SqlClient;
      yield* inbound.receive(ask);

      const reply = yield* send
        .send({
          commandId: CommCommandId.make("command:peer-inbound:reply"),
          senderThreadId: triage.threadId,
          to: remoteAsker,
          message: "Resolved at 09:41.",
          exchangeId: ExchangeId.make(ask.exchangeId!),
          acceptedAt: timestamp,
        })
        .pipe(Effect.result);
      // Resolving the remote asker as a receiver is the next PR's work; the
      // exchange guard itself must already accept this reply's squadron.
      if (reply._tag === "Failure") {
        assert.notEqual(reply.failure._tag, "A2ACrossSquadronReplyInvariantError");
        assert.notEqual(reply.failure._tag, "A2AExchangeNotOpenError");
        assert.notEqual(reply.failure._tag, "A2AExchangeParticipantMismatchError");
      }
      const open = yield* sql<{ readonly status: string }>`
        SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${ask.exchangeId}
      `;
      assert.equal(open[0]?.status, "open", "an unresolved receiver leaves the debt standing");
    }).pipe(Effect.provide(makeTestLayer(delivered)));
  }),
);

it.effect("closes the local agent's open ask when the peer's reply arrives", () =>
  Effect.gen(function* () {
    const delivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
    yield* Effect.gen(function* () {
      yield* setup();
      const inbound = yield* PeerInboundService;
      const ledger = yield* A2ALedger;
      const worker = yield* A2ADeliveryWorker;
      const sql = yield* SqlClient.SqlClient;
      // The local agent asked the remote one earlier; only the Exchange fact matters here.
      yield* ledger.append({
        commandId: CommCommandId.make("command:peer-inbound:local-ask"),
        squadronId: localSquadron,
        acceptedAt: timestamp,
        event: {
          kind: "exchange.opened",
          sender: triage.id,
          receiver: remoteAsker,
          exchangeId: ExchangeId.make("exchange:j5:a2a:local-ask"),
          correlationId: CorrelationId.make("correlation:j5:a2a:local-ask"),
          payload: { intent: "schema target", urgency: null },
          createdAt: timestamp,
        },
      });

      yield* inbound.receive({
        ...askWithoutIntent,
        messageId: "message:j5:a2a:remote-reply",
        exchangeId: "exchange:j5:a2a:local-ask",
        correlationId: "correlation:j5:a2a:remote-reply",
        exchangeRole: "reply",
        text: "v12.",
      });
      const exchange = yield* sql<{ readonly status: string }>`
        SELECT status FROM j5_a2a_exchange WHERE exchange_id = 'exchange:j5:a2a:local-ask'
      `;
      assert.deepStrictEqual(exchange, [{ status: "closed" }]);
      assert.equal((yield* worker.runOnce)?.state, "delivered");
      assert.equal((yield* Ref.get(delivered))[0]!.exchangeRole, "reply");
    }).pipe(Effect.provide(makeTestLayer(delivered)));
  }),
);

it.effect(
  "refuses an unknown, archived, human, or machine receiver and an ask without intent",
  () =>
    Effect.gen(function* () {
      const delivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
      yield* Effect.gen(function* () {
        yield* setup();
        const inbound = yield* PeerInboundService;
        const ledger = yield* A2ALedger;
        // Each refusal is its own message: a repeated message id would replay, not refuse.
        let refused = 0;
        const fail = (input: Partial<PeerInboundInput>) =>
          Effect.flip(
            inbound.receive({
              ...ask,
              messageId: `message:j5:a2a:refused-${String((refused += 1))}`,
              correlationId: `correlation:j5:a2a:refused-${String(refused)}`,
              ...input,
            }),
          );
        yield* inbound.receive(ask);

        assert.equal(
          (yield* fail({ receiverId: "agent:j5:a2a:thread:ghost" }))._tag,
          "A2APeerReceiverNotFoundError",
        );
        assert.equal(
          (yield* fail({ receiverId: "human:someone" }))._tag,
          "A2APeerReceiverNotDeliverableError",
        );
        assert.equal(
          (yield* fail({ receiverId: "machine:watchdog" }))._tag,
          "A2APeerReceiverNotDeliverableError",
        );
        assert.equal(
          (yield* Effect.flip(
            inbound.receive({
              ...askWithoutIntent,
              messageId: "message:j5:a2a:refused-no-intent",
              correlationId: "correlation:j5:a2a:refused-no-intent",
            }),
          ))._tag,
          "A2APeerAskIntentRequiredError",
        );

        yield* ledger.append({
          commandId: CommCommandId.make("command:peer-inbound:archive"),
          squadronId: localSquadron,
          acceptedAt: timestamp,
          event: {
            kind: "participant.archived",
            sender: null,
            receiver: triage.id,
            exchangeId: null,
            correlationId: null,
            payload: { participant: triage },
            createdAt: timestamp,
          },
        });
        const archived = yield* fail({});
        assert.equal(archived._tag, "A2APeerReceiverNotDeliverableError");
        assert.include(archived.message, "archived");
        // The ask recorded above still replays: the receipt outlives the receiver's membership.
        const replayed = yield* inbound.receive(ask);
        assert.isTrue(replayed.replay);
      }).pipe(Effect.provide(makeTestLayer(delivered)));
    }),
);
