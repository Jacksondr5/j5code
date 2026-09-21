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
import { noneLayer as peerDirectoryNoneLayer } from "./PeerDirectory.ts";
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
  LedgerMessageId,
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
  const send = sendLayer.pipe(
    Layer.provide(peerDirectoryNoneLayer),
    Layer.provide(ledger),
    Layer.provide(database),
  );
  const inbound = peerInboundLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const transport: A2ADeliveryTransportShape = {
    cancelAgent: () => Effect.succeed("cancelled" as const),
    deliverAgent: (input) => Ref.update(delivered, (rows) => [...rows, input]),
    deliverPeer: () => Effect.die("peer delivery is not under test"),
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
  originSquadronName: "Home Support",
  senderLabel: "Incident asker",
  intent: "incident status",
  createdAt: timestamp,
  originEnvironmentId: homeEnvironment,
};
const { intent: _askIntent, ...askWithoutIntent } = ask;
/** The id this ledger keys a peer's message by: the origin's id under its environment. */
const localMessageId = (messageId: string) =>
  `message:j5:a2a:peer:${homeEnvironment}:${encodeURIComponent(messageId)}`;

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
        const names = yield* sql<{
          readonly squadron_name: string | null;
          readonly sender_label: string | null;
        }>`
          SELECT json_extract(payload, '$.originSquadronName') AS squadron_name,
                 json_extract(payload, '$.senderLabel') AS sender_label
          FROM j5_a2a_comm_event
          WHERE squadron_id = ${localSquadron} AND kind = 'message.received'
        `;
        assert.deepStrictEqual(
          names,
          [{ squadron_name: "Home Support", sender_label: "Incident asker" }],
          "the names the origin sent stay with the received row for the client",
        );
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
        }>`SELECT status, origin_squadron_id, origin_environment_id FROM j5_a2a_delivery WHERE message_id = ${localMessageId(ask.messageId)}`;
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
      // The remote asker resolves through the route its ask recorded, so the
      // reply is an ordinary same-Squadron reply headed back to that peer.
      assert.equal(reply._tag, "Success");
      const exchange = yield* sql<{ readonly status: string }>`
        SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${ask.exchangeId}
      `;
      assert.equal(exchange[0]?.status, "closed", "the reply settles the debt the ask opened here");
      const outbound = yield* sql<{ readonly receiver_environment_id: string | null }>`
        SELECT receiver_environment_id FROM j5_a2a_delivery
        WHERE sender_id = ${triage.id} AND receiver_id = ${remoteAsker}
      `;
      assert.deepStrictEqual(outbound, [{ receiver_environment_id: homeEnvironment }]);
    }).pipe(Effect.provide(makeTestLayer(delivered)));
  }),
);

/** Triage asked the remote agent on Home: the Exchange and the outbound ask that recorded Home as its route. */
const recordLocalAsk = Effect.fn("test.j5.a2a.peer.inbound.recordLocalAsk")(function* () {
  yield* (yield* A2ALedger).appendEvents({
    commandId: CommCommandId.make("command:peer-inbound:local-ask"),
    squadronId: localSquadron,
    acceptedAt: timestamp,
    events: [
      {
        kind: "exchange.opened",
        sender: triage.id,
        receiver: remoteAsker,
        exchangeId: ExchangeId.make("exchange:j5:a2a:local-ask"),
        correlationId: CorrelationId.make("correlation:j5:a2a:local-ask"),
        payload: { intent: "schema target", urgency: null },
        createdAt: timestamp,
      },
      {
        kind: "message.sent",
        sender: triage.id,
        receiver: remoteAsker,
        exchangeId: ExchangeId.make("exchange:j5:a2a:local-ask"),
        correlationId: CorrelationId.make("correlation:j5:a2a:local-ask"),
        payload: {
          messageId: LedgerMessageId.make("message:j5:a2a:local-ask"),
          text: "Which schema version do we target?",
          originSquadronId: localSquadron,
          receiverSquadronId: homeSquadron,
          receiverEnvironmentId: homeEnvironment,
          exchangeRole: "ask",
          envelopeChannel: "peer",
        },
        createdAt: timestamp,
      },
      // Already delivered, so the worker under test has only the inbound rows left.
      {
        kind: "message.delivered",
        sender: triage.id,
        receiver: remoteAsker,
        exchangeId: ExchangeId.make("exchange:j5:a2a:local-ask"),
        correlationId: CorrelationId.make("correlation:j5:a2a:local-ask"),
        payload: {
          messageId: LedgerMessageId.make("message:j5:a2a:local-ask"),
          attempt: 1,
          channel: "agent",
        },
        createdAt: timestamp,
      },
    ],
  });
});

it.effect("closes the local agent's open ask when the peer's reply arrives", () =>
  Effect.gen(function* () {
    const delivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
    yield* Effect.gen(function* () {
      yield* setup();
      const inbound = yield* PeerInboundService;
      const worker = yield* A2ADeliveryWorker;
      const sql = yield* SqlClient.SqlClient;
      // The local agent asked the remote one earlier: the Exchange plus the
      // delivery row that records which peer the ask went to.
      yield* recordLocalAsk();

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
        const noIntent = yield* Effect.flip(
          inbound.receive({
            ...askWithoutIntent,
            messageId: "message:j5:a2a:refused-no-intent",
            correlationId: "correlation:j5:a2a:refused-no-intent",
          }),
        );
        assert.equal(noIntent._tag, "A2APeerAskIntentRequiredError");
        const noExchange = yield* fail({ exchangeId: null });
        assert.equal(noExchange._tag, "A2APeerAskIntentRequiredError");
        assert.include(noExchange.message, "Exchange id");

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

it.effect(
  "refuses a peer that speaks as a person, a machine, the platform, or off the peer channel",
  () =>
    Effect.gen(function* () {
      const delivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
      yield* Effect.gen(function* () {
        yield* setup();
        const inbound = yield* PeerInboundService;
        const sql = yield* SqlClient.SqlClient;
        let n = 0;
        const forged = (input: Partial<PeerInboundInput>) =>
          Effect.flip(
            inbound.receive({
              ...ask,
              exchangeRole: "none",
              exchangeId: null,
              messageId: `message:j5:a2a:forged-${String((n += 1))}`,
              correlationId: `correlation:j5:a2a:forged-${String(n)}`,
              ...input,
            }),
          );
        const cases: ReadonlyArray<[Partial<PeerInboundInput>, string]> = [
          [{ senderId: "human:someone", exchangeRole: "reply", exchangeId: "exchange:x" }, "human"],
          [{ senderId: "machine:watchdog" }, "machine"],
          // The platform speaks only as the two ids that end Exchanges, each on its own channel, carrying the fact.
          [{ senderId: "platform:someone-else", envelopeChannel: "lifecycle_notice" }, "platform"],
          [
            {
              senderId: "platform:silence-detector",
              envelopeChannel: "lifecycle_notice",
              exchangeRole: "terminal_notice",
              exchangeId: "exchange:x",
              terminal: { kind: "sender-cleared" },
            },
            "platform",
          ],
          [
            {
              senderId: "platform:lifecycle",
              envelopeChannel: "lifecycle_notice",
              exchangeRole: "terminal_notice",
              exchangeId: "exchange:x",
            },
            "platform",
          ],
          // Well-formed, but about an Exchange this peer is no party to.
          [
            {
              senderId: "platform:lifecycle",
              envelopeChannel: "lifecycle_notice",
              exchangeRole: "terminal_notice",
              exchangeId: "exchange:x",
              terminal: { kind: "sender-cleared" },
            },
            "exchange",
          ],
          [{ envelopeChannel: "lifecycle_notice" }, "channel"],
          [{ exchangeRole: "terminal_notice", exchangeId: "exchange:x" }, "role"],
        ];
        for (const [input, reason] of cases) {
          const refused = yield* forged(input);
          assert.equal(refused._tag, "A2APeerSenderNotAllowedError", reason);
          assert.equal((refused as { readonly reason?: string }).reason, reason);
        }
        const written = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM j5_a2a_comm_event WHERE kind = 'message.received'
      `;
        assert.equal(written[0]?.count, 0, "a refused sender leaves no received row");
      }).pipe(Effect.provide(makeTestLayer(delivered)));
    }),
);

it.effect("keys the received message by origin and stamps it with this server's clock", () =>
  Effect.gen(function* () {
    const delivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
    yield* Effect.gen(function* () {
      yield* setup();
      const inbound = yield* PeerInboundService;
      const worker = yield* A2ADeliveryWorker;
      const sql = yield* SqlClient.SqlClient;
      yield* inbound.receive({ ...ask, createdAt: "2099-01-01T00:00:00.000Z" });
      const rows = yield* sql<{
        readonly message_id: string;
        readonly created_at: string;
        readonly origin_message_id: string | null;
        readonly origin_created_at: string | null;
      }>`
        SELECT delivery.message_id, delivery.created_at,
               json_extract(event.payload, '$.originMessageId') AS origin_message_id,
               json_extract(event.payload, '$.originCreatedAt') AS origin_created_at
        FROM j5_a2a_delivery AS delivery
        JOIN j5_a2a_comm_event AS event ON event.seq = delivery.sent_seq
      `;
      assert.equal(rows.length, 1);
      assert.equal(
        rows[0]!.message_id,
        localMessageId(ask.messageId),
        "a peer's id can never collide with a local message or another peer's",
      );
      assert.equal(rows[0]!.origin_message_id, ask.messageId);
      assert.equal(rows[0]!.origin_created_at, "2099-01-01T00:00:00.000Z");
      assert.notEqual(
        rows[0]!.created_at,
        "2099-01-01T00:00:00.000Z",
        "the origin's clock is display only",
      );
      assert.equal((yield* worker.runOnce)?.state, "delivered");
      assert.equal((yield* Ref.get(delivered))[0]!.messageId, rows[0]!.message_id);
    }).pipe(Effect.provide(makeTestLayer(delivered)));
  }),
);

it.effect(
  "drops the local Exchange the same way the origin did when a terminal notice arrives",
  () =>
    Effect.gen(function* () {
      const delivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
      yield* Effect.gen(function* () {
        yield* setup();
        const inbound = yield* PeerInboundService;
        const worker = yield* A2ADeliveryWorker;
        const sql = yield* SqlClient.SqlClient;
        // The remote agent asked triage; the remote agent is then archived over there.
        yield* inbound.receive(ask);
        yield* inbound.receive({
          ...askWithoutIntent,
          messageId: "message:j5:a2a:lifecycle:drop:remote",
          senderId: "platform:lifecycle",
          correlationId: "correlation:j5:a2a:lifecycle:drop:remote",
          exchangeRole: "terminal_notice",
          envelopeChannel: "lifecycle_notice",
          text: "[Cross-agent messaging system notice: exchange dropped]",
          terminal: {
            kind: "dropped",
            cause: {
              kind: "participant-archived",
              participantId: remoteAsker,
              squadronId: homeSquadron,
            },
          },
        });
        const exchange = yield* sql<{ readonly status: string }>`
        SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${ask.exchangeId}
      `;
        assert.deepStrictEqual(exchange, [{ status: "dropped" }]);
        const dropped = yield* sql<{ readonly disposition: string; readonly notice: string }>`
        SELECT json_extract(payload, '$.disposition') AS disposition,
               json_extract(payload, '$.noticeMessageId') AS notice
        FROM j5_a2a_comm_event WHERE kind = 'exchange.dropped' AND exchange_id = ${ask.exchangeId}
      `;
        // The notice is keyed the way every peer row is: by origin, under this ledger's namespace.
        assert.deepStrictEqual(dropped, [
          {
            disposition: "sender-retired",
            notice: localMessageId("message:j5:a2a:lifecycle:drop:remote"),
          },
        ]);
        // Both the ask and the notice still reach the agent's thread.
        assert.equal((yield* worker.runOnce)?.state, "delivered");
        assert.equal((yield* worker.runOnce)?.state, "delivered");
        assert.deepStrictEqual(
          (yield* Ref.get(delivered)).map((row) => row.envelopeChannel),
          ["peer", "lifecycle_notice"],
        );
      }).pipe(Effect.provide(makeTestLayer(delivered)));
    }),
);

it.effect("lets a peer speak only for agents it owns, and end only Exchanges it is party to", () =>
  Effect.gen(function* () {
    const delivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
    yield* Effect.gen(function* () {
      yield* setup();
      const inbound = yield* PeerInboundService;
      const sql = yield* SqlClient.SqlClient;
      yield* recordLocalAsk();

      // A different peer claims to be the agent Home owns: refused outright.
      const impostor = yield* Effect.flip(
        inbound.receive({
          ...askWithoutIntent,
          originEnvironmentId: "environment-stranger",
          messageId: "message:j5:a2a:impostor-reply",
          exchangeId: "exchange:j5:a2a:local-ask",
          correlationId: "correlation:j5:a2a:impostor-reply",
          exchangeRole: "reply",
          text: "v99.",
        }),
      );
      assert.equal(impostor._tag, "A2APeerSenderNotOwnedError");
      // A peer claiming one of our own agents as its sender: refused too.
      const localClaim = yield* Effect.flip(
        inbound.receive({
          ...askWithoutIntent,
          senderId: triage.id,
          messageId: "message:j5:a2a:local-claim",
          correlationId: "correlation:j5:a2a:local-claim",
          exchangeRole: "none",
          exchangeId: null,
        }),
      );
      assert.equal(localClaim._tag, "A2APeerSenderNotOwnedError");
      const stillOpen = yield* sql<{ readonly status: string }>`
        SELECT status FROM j5_a2a_exchange WHERE exchange_id = 'exchange:j5:a2a:local-ask'
      `;
      assert.deepStrictEqual(stillOpen, [{ status: "open" }]);

      // A terminal notice naming a retired party that is not the Exchange's other party drops nothing.
      yield* inbound.receive({
        ...askWithoutIntent,
        senderId: "platform:lifecycle",
        messageId: "message:j5:a2a:wrong-terminal",
        exchangeId: "exchange:j5:a2a:local-ask",
        correlationId: "correlation:j5:a2a:wrong-terminal",
        exchangeRole: "terminal_notice",
        envelopeChannel: "lifecycle_notice",
        text: "notice",
        terminal: {
          kind: "dropped",
          cause: {
            kind: "participant-archived",
            participantId: "agent:j5:a2a:thread:somebody-else",
            squadronId: homeSquadron,
          },
        },
      });
      const afterWrongNotice = yield* sql<{ readonly status: string }>`
        SELECT status FROM j5_a2a_exchange WHERE exchange_id = 'exchange:j5:a2a:local-ask'
      `;
      assert.deepStrictEqual(afterWrongNotice, [{ status: "open" }]);
    }).pipe(Effect.provide(makeTestLayer(delivered)));
  }),
);

it.effect("closes the local Exchange as sender-cleared when the remote asker withdraws", () =>
  Effect.gen(function* () {
    const delivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
    yield* Effect.gen(function* () {
      yield* setup();
      const inbound = yield* PeerInboundService;
      const sql = yield* SqlClient.SqlClient;
      yield* inbound.receive(ask);
      yield* inbound.receive({
        ...askWithoutIntent,
        senderId: "platform:lifecycle",
        messageId: "message:j5:a2a:withdraw:remote",
        correlationId: "correlation:j5:a2a:withdraw:remote",
        exchangeRole: "terminal_notice",
        envelopeChannel: "lifecycle_notice",
        text: "[Cross-agent messaging system notice: exchange withdrawn]",
        terminal: { kind: "sender-cleared" },
      });
      const closed = yield* sql<{ readonly status: string; readonly closure: string | null }>`
        SELECT e.status, json_extract(c.payload, '$.closureKind') AS closure
        FROM j5_a2a_exchange e
        LEFT JOIN j5_a2a_comm_event c ON c.exchange_id = e.exchange_id AND c.kind = 'exchange.closed'
        WHERE e.exchange_id = ${ask.exchangeId}
      `;
      assert.deepStrictEqual(closed, [{ status: "closed", closure: "sender-cleared" }]);
      // The fact is recorded, the ask is still delivered, and no notice is injected into the agent's thread.
      const pending = yield* sql<{ readonly envelope_channel: string }>`
        SELECT envelope_channel FROM j5_a2a_delivery ORDER BY sent_seq
      `;
      assert.deepStrictEqual(pending, [{ envelope_channel: "peer" }]);
      const facts = yield* sql<{ readonly injection: string | null }>`
        SELECT json_extract(payload, '$.injection') AS injection
        FROM j5_a2a_comm_event WHERE kind = 'message.received' ORDER BY seq
      `;
      assert.deepStrictEqual(facts, [{ injection: null }, { injection: "none" }]);
    }).pipe(Effect.provide(makeTestLayer(delivered)));
  }),
);
