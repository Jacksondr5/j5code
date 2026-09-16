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
  A2ADeliveryTransportError,
  type AgentDeliveryInput,
  type PeerDeliveryInput,
} from "./DeliveryTransport.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { PeerDirectory, type RemoteAgent } from "./PeerDirectory.ts";
import {
  PeerInboundService,
  layer as peerInboundLayer,
  type PeerInboundServiceShape,
} from "./PeerInboundService.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import {
  CommCommandId,
  ExchangeId,
  ParticipantId,
  SquadronId,
  type AgentParticipant,
} from "./contracts.ts";

/**
 * Two servers, each with its own database, ledger, send service, inbound
 * service, and worker. The peer transport of each hands the message straight to
 * the other's inbound service, standing in for the HTTP hop, so what is under
 * test is the protocol: an ask crosses, opens the Exchange on both sides, is
 * answered, and the reply closes both.
 */

const timestamp = "2026-09-16T12:00:00.000Z";

interface Server {
  readonly environmentId: string;
  readonly squadronId: SquadronId;
  readonly agent: AgentParticipant;
}

const work: Server = {
  environmentId: "environment-work",
  squadronId: SquadronId.make("squadron:work-billing"),
  agent: {
    kind: "agent",
    id: ParticipantId.make("agent:j5:a2a:thread:billing"),
    threadId: ThreadId.make("thread:billing"),
  },
};
const home: Server = {
  environmentId: "environment-home",
  squadronId: SquadronId.make("squadron:home-support"),
  agent: {
    kind: "agent",
    id: ParticipantId.make("agent:j5:a2a:thread:support"),
    threadId: ThreadId.make("thread:support"),
  },
};

const remoteView = (server: Server, label: string): RemoteAgent => ({
  environmentId: server.environmentId,
  environmentLabel: label,
  squadronId: server.squadronId,
  squadronName: label,
  participantId: server.agent.id,
  threadId: server.agent.threadId,
  displayName: label,
  archived: false,
  canReceiveMessage: true,
});

/** One server's runtime; `peer` is the other server's inbound door, wired after both exist. */
const makeServer = (
  self: Server,
  other: Server,
  otherLabel: string,
  peer: Ref.Ref<PeerInboundServiceShape | null>,
  delivered: Ref.Ref<Array<AgentDeliveryInput>>,
  crossed: Ref.Ref<Array<PeerDeliveryInput>>,
) => {
  const database = NodeSqliteClient.layerMemory();
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const directory = Layer.succeed(
    PeerDirectory,
    PeerDirectory.of({
      listAgents: () =>
        Effect.succeed({ agents: [remoteView(other, otherLabel)], unreadPeers: [] }),
      resolveAgent: (id) =>
        Effect.succeed({
          agents: id === other.agent.id ? [remoteView(other, otherLabel)] : [],
          unreadPeers: [],
        }),
    }),
  );
  const send = sendLayer.pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(directory),
  );
  const inbound = peerInboundLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const transport = Layer.succeed(
    A2ADeliveryTransport,
    A2ADeliveryTransport.of({
      cancelAgent: () => Effect.succeed("cancelled" as const),
      deliverAgent: (input) => Ref.update(delivered, (rows) => [...rows, input]),
      deliverHuman: () => Effect.void,
      deliverPeer: (input) =>
        Effect.gen(function* () {
          const door = yield* Ref.get(peer);
          if (door === null) {
            return yield* new A2ADeliveryTransportError({
              operation: "deliver to peer",
              cause: "peer is unreachable",
            });
          }
          yield* Ref.update(crossed, (rows) => [...rows, input]);
          const intent = input.exchangeRole === "ask" ? { intent: "incident status" } : {};
          yield* door
            .receive({
              messageId: input.messageId,
              senderId: input.senderId,
              receiverId: input.receiverId,
              exchangeId: input.exchangeId,
              correlationId: `correlation:${input.messageId}`,
              exchangeRole: input.exchangeRole,
              envelopeChannel: input.envelopeChannel,
              text: input.message,
              originSquadronId: input.originSquadronId,
              ...intent,
              createdAt: input.createdAt,
              originEnvironmentId: self.environmentId,
            })
            .pipe(
              Effect.mapError(
                (cause) => new A2ADeliveryTransportError({ operation: "deliver to peer", cause }),
              ),
            );
        }),
    }),
  );
  const worker = deliveryWorkerLayerWithHooks(false).pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(transport),
    Layer.provide(
      Layer.succeed(
        A2ADeliveryHooks,
        A2ADeliveryHooks.of({ afterTransportSuccess: () => Effect.void }),
      ),
    ),
  );
  return Layer.mergeAll(database, ledger, send, inbound, worker);
};

const seed = Effect.fn("test.j5.a2a.peer.roundtrip.seed")(function* (self: Server, name: string) {
  yield* runJ5A2AMigrations();
  const ledger = yield* A2ALedger;
  yield* ledger.createSquadron({
    squadron: { id: self.squadronId, name, createdAt: timestamp },
  });
  yield* ledger.append({
    commandId: CommCommandId.make(`command:roundtrip:join:${self.agent.id}`),
    squadronId: self.squadronId,
    acceptedAt: timestamp,
    event: {
      kind: "participant.joined",
      sender: null,
      receiver: self.agent.id,
      exchangeId: null,
      correlationId: null,
      payload: { participant: self.agent },
      createdAt: timestamp,
    },
  });
  return {
    send: yield* A2ASendService,
    inbound: yield* PeerInboundService,
    worker: yield* A2ADeliveryWorker,
    sql: yield* SqlClient.SqlClient,
  };
});

const exchangeStatus = (sql: SqlClient.SqlClient, exchangeId: string) =>
  sql<{ readonly status: string; readonly sender_id: string }>`
    SELECT status, sender_id FROM j5_a2a_exchange WHERE exchange_id = ${exchangeId}
  `;

it.effect(
  "carries an ask from one server to another and the reply back, closing both Exchanges",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workDoor = yield* Ref.make<PeerInboundServiceShape | null>(null);
        const homeDoor = yield* Ref.make<PeerInboundServiceShape | null>(null);
        const workDelivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
        const homeDelivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
        const workCrossed = yield* Ref.make<Array<PeerDeliveryInput>>([]);
        const homeCrossed = yield* Ref.make<Array<PeerDeliveryInput>>([]);

        // Two runtimes with two databases, both alive for the whole scenario.
        const workContext = yield* Layer.build(
          makeServer(work, home, "Home", homeDoor, workDelivered, workCrossed),
        );
        const homeContext = yield* Layer.build(
          makeServer(home, work, "Work", workDoor, homeDelivered, homeCrossed),
        );
        const workServer = yield* seed(work, "Billing Migration").pipe(Effect.provide(workContext));
        const homeServer = yield* seed(home, "L2 Support Rotation").pipe(
          Effect.provide(homeContext),
        );
        yield* Ref.set(workDoor, workServer.inbound);
        yield* Ref.set(homeDoor, homeServer.inbound);

        // Work asks Home by participant id, naming no server.
        const asked = yield* workServer.send.send({
          commandId: CommCommandId.make("command:roundtrip:ask"),
          senderThreadId: work.agent.threadId,
          to: home.agent.id,
          message: "What is the incident status?",
          expectReply: true,
          intent: "incident status",
          acceptedAt: timestamp,
        });
        assert.equal(asked.exchangeState, "open");
        const askRow = yield* workServer.sql<{
          readonly receiver_environment_id: string | null;
          readonly receiver_squadron_id: string;
        }>`SELECT receiver_environment_id, receiver_squadron_id FROM j5_a2a_delivery WHERE message_id = ${asked.messageId}`;
        assert.deepStrictEqual(askRow, [
          { receiver_environment_id: home.environmentId, receiver_squadron_id: home.squadronId },
        ]);

        // Work's worker crosses; Home records its own row and delivers locally.
        assert.equal((yield* workServer.worker.runOnce)?.state, "delivered");
        assert.equal((yield* Ref.get(workCrossed)).length, 1);
        assert.deepStrictEqual(yield* Ref.get(workDelivered), [], "nothing was injected on Work");
        const workReceived = yield* workServer.sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM j5_a2a_comm_event WHERE kind = 'message.received'
    `;
        assert.deepStrictEqual(
          workReceived,
          [{ count: 0 }],
          "the peer writes the received row, not the sender",
        );
        assert.deepStrictEqual(yield* exchangeStatus(homeServer.sql, asked.exchangeId!), [
          { status: "open", sender_id: work.agent.id },
        ]);
        assert.equal((yield* homeServer.worker.runOnce)?.state, "delivered");
        const homeInjected = yield* Ref.get(homeDelivered);
        assert.equal(homeInjected.length, 1);
        assert.equal(
          homeInjected[0]!.originSquadronId,
          work.squadronId,
          "the envelope names Work's Squadron",
        );
        assert.equal(homeInjected[0]!.senderId, work.agent.id);

        // Home replies to the Exchange it now holds; the reply crosses back and closes Work's Exchange.
        const replied = yield* homeServer.send.send({
          commandId: CommCommandId.make("command:roundtrip:reply"),
          senderThreadId: home.agent.threadId,
          to: work.agent.id,
          message: "Resolved at 09:41.",
          exchangeId: ExchangeId.make(asked.exchangeId!),
          acceptedAt: timestamp,
        });
        assert.equal(replied.exchangeState, "closed");
        assert.deepStrictEqual(yield* exchangeStatus(homeServer.sql, asked.exchangeId!), [
          { status: "closed", sender_id: work.agent.id },
        ]);
        assert.deepStrictEqual(yield* exchangeStatus(workServer.sql, asked.exchangeId!), [
          { status: "open", sender_id: work.agent.id },
        ]);
        assert.equal((yield* homeServer.worker.runOnce)?.state, "delivered");
        assert.deepStrictEqual(yield* exchangeStatus(workServer.sql, asked.exchangeId!), [
          { status: "closed", sender_id: work.agent.id },
        ]);
        assert.equal((yield* workServer.worker.runOnce)?.state, "delivered");
        const workInjected = yield* Ref.get(workDelivered);
        assert.equal(workInjected.length, 1);
        assert.equal(workInjected[0]!.exchangeRole, "reply");
        assert.equal(workInjected[0]!.message, "Resolved at 09:41.");
        assert.isNull(yield* workServer.worker.runOnce);
        assert.isNull(yield* homeServer.worker.runOnce);
      }),
    ),
);

it.effect(
  "alarms the sender when the peer cannot be reached, and never writes a received row anywhere",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const noDoor = yield* Ref.make<PeerInboundServiceShape | null>(null);
        const delivered = yield* Ref.make<Array<AgentDeliveryInput>>([]);
        const crossed = yield* Ref.make<Array<PeerDeliveryInput>>([]);
        const context = yield* Layer.build(
          makeServer(work, home, "Home", noDoor, delivered, crossed),
        );
        const server = yield* seed(work, "Billing Migration").pipe(Effect.provide(context));
        const sent = yield* server.send.send({
          commandId: CommCommandId.make("command:roundtrip:dark"),
          senderThreadId: work.agent.threadId,
          to: home.agent.id,
          message: "Anyone there?",
          acceptedAt: timestamp,
        });
        const first = yield* server.worker.runOnce;
        assert.equal(first?.state, "retry_scheduled");
        assert.equal(first?.messageId, sent.messageId);
        const state = yield* server.sql<{ readonly status: string; readonly last_error: string }>`
      SELECT status, last_error FROM j5_a2a_delivery WHERE message_id = ${sent.messageId}
    `;
        assert.equal(state[0]?.status, "retry_scheduled");
        assert.include(state[0]?.last_error ?? "", "peer is unreachable");
        assert.deepStrictEqual(yield* Ref.get(delivered), []);
      }),
    ),
);
