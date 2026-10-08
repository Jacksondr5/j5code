import { EnvironmentId, ExecutionEnvironmentDescriptor, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { A2ADeliveryTransport, type A2ADeliveryTransportShape } from "./DeliveryTransport.ts";
import {
  A2ADeliveryHooks,
  A2ADeliveryWorker,
  layer as deliveryWorkerDaemonLayer,
  layerWithHooks as deliveryWorkerLayerWithHooks,
  manualLayer as deliveryWorkerLayer,
} from "./DeliveryWorker.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { PeerInboundService, layer as peerInboundLayer } from "./PeerInboundService.ts";
import { layer as peerRegistryLayer } from "./PeerRegistryService.ts";
import { PeerRemovalService, layer as peerRemovalLayer } from "./PeerRemovalService.ts";
import {
  CommCommandId,
  CorrelationId,
  LIFECYCLE_PARTICIPANT_ID,
  ExchangeId,
  LedgerMessageId,
  ParticipantId,
  SquadronId,
  type AgentParticipant,
  type MachineParticipant,
} from "./contracts.ts";

/**
 * Removing a peer on the work VM, which stores messages for a laptop that
 * polls it. The ledger, worker, registry and inbound service are real; nothing
 * is delivered, so each assertion reads what the ledger now holds.
 */

const timestamp = "2026-10-02T12:00:00.000Z";
const laptop = "environment-laptop";
const otherPeer = "environment-home";
const vmSquadron = SquadronId.make("squadron:work-billing");
const laptopSquadron = SquadronId.make("squadron:laptop-ios");
const billing: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:j5:a2a:thread:billing"),
  threadId: ThreadId.make("thread:billing"),
};
const iosBuild = ParticipantId.make("agent:j5:a2a:thread:ios-build");
const watchdog: MachineParticipant = {
  kind: "machine",
  id: ParticipantId.make("machine:billing-watchdog"),
  name: "billing-watchdog",
};

const descriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)({
  environmentId: "environment-work",
  label: "Work VM",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: {},
});

/**
 * `delivering` runs the worker as the server does, as a daemon that delivers
 * to agents here, so a test can wait for a notice's receipt. `deliverPeer`
 * stands in for a direct send to the peer, so a test can hold one mid-attempt,
 * and `waitsForDrain` runs when a removal's cancel waits for that attempt.
 */
const makeTestLayer = (
  options: {
    readonly delivering?: boolean;
    readonly deliverPeer?: A2ADeliveryTransportShape["deliverPeer"];
    readonly waitsForDrain?: Effect.Effect<void>;
  } = {},
) => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const transport = Layer.succeed(
    A2ADeliveryTransport,
    A2ADeliveryTransport.of({
      cancelAgent: () => Effect.succeed("cancelled" as const),
      deliverAgent: () =>
        options.delivering === true ? Effect.void : Effect.die("nothing is delivered here"),
      deliverHuman: () => Effect.die("nothing is delivered here"),
      deliverPeer: options.deliverPeer ?? (() => Effect.die("nothing is delivered here")),
    }),
  );
  const worker = (
    options.waitsForDrain !== undefined
      ? deliveryWorkerLayerWithHooks(false).pipe(
          Layer.provide(
            Layer.succeed(
              A2ADeliveryHooks,
              A2ADeliveryHooks.of({
                afterTransportSuccess: () => Effect.void,
                peerCancelWaitsForDrain: options.waitsForDrain,
              }),
            ),
          ),
        )
      : options.delivering === true
        ? deliveryWorkerDaemonLayer
        : deliveryWorkerLayer
  ).pipe(Layer.provide(ledger), Layer.provide(database), Layer.provide(transport));
  const registry = peerRegistryLayer.pipe(
    Layer.provide(database),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("removal calls no peer")),
      ),
    ),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-work")),
        getDescriptor: Effect.succeed(descriptor),
      }),
    ),
    Layer.provide(
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({ listSessions: () => Effect.succeed([]) }),
    ),
  );
  const removal = peerRemovalLayer.pipe(
    Layer.provide(registry),
    Layer.provide(ledger),
    Layer.provide(worker),
    Layer.provide(database),
  );
  const inbound = peerInboundLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  return Layer.mergeAll(database, ledger, worker, removal, inbound);
};

const seed = Effect.fn("test.j5.a2a.peer.removal.seed")(function* () {
  yield* runMigrations();
  yield* runJ5A2AMigrations();
  const ledger = yield* A2ALedger;
  const sql = yield* SqlClient.SqlClient;
  yield* ledger.ensureProject({ projectId: vmSquadron, createdAt: timestamp });
  yield* ledger.append({
    commandId: CommCommandId.make("command:peer-removal:join"),
    squadronId: vmSquadron,
    acceptedAt: timestamp,
    event: {
      kind: "participant.joined",
      sender: null,
      receiver: billing.id,
      exchangeId: null,
      correlationId: null,
      payload: { participant: billing },
      createdAt: timestamp,
    },
  });
  for (const [environmentId, label] of [
    [laptop, "JM-LT-04213"],
    [otherPeer, "Home Mac"],
  ] as const) {
    yield* sql`
      INSERT INTO j5_a2a_peer (environment_id, label, link_mode, created_at, updated_at)
      VALUES (${environmentId}, ${label}, 'store', ${timestamp}, ${timestamp})
    `;
  }
  yield* sql`
    INSERT INTO j5_a2a_peer_store_grant (environment_id, session_id, issued_at)
    VALUES (${laptop}, 'auth-session:laptop', ${timestamp})
  `;
});

/** Billing sends the laptop's agent a message, stored for the laptop or another peer. */
const sendFromBilling = (
  name: string,
  options: {
    readonly ask?: boolean;
    readonly environmentId?: string;
    readonly sender?: ParticipantId;
  } = {},
) =>
  Effect.gen(function* () {
    const ledger = yield* A2ALedger;
    const exchangeId = options.ask === true ? ExchangeId.make(`exchange:${name}`) : null;
    const correlationId = CorrelationId.make(`correlation:${name}`);
    const sender = options.sender ?? billing.id;
    yield* ledger.appendEvents({
      commandId: CommCommandId.make(`command:peer-removal:${name}`),
      squadronId: vmSquadron,
      acceptedAt: timestamp,
      events: [
        ...(exchangeId === null
          ? []
          : [
              {
                kind: "exchange.opened" as const,
                sender,
                receiver: iosBuild,
                exchangeId,
                correlationId,
                payload: { intent: `${name} intent`, urgency: null },
                createdAt: timestamp,
              },
            ]),
        {
          kind: "message.sent",
          sender,
          receiver: iosBuild,
          exchangeId,
          correlationId,
          payload: {
            messageId: LedgerMessageId.make(`message:${name}`),
            text: `${name} text`,
            originProjectId: vmSquadron,
            receiverProjectId: laptopSquadron,
            receiverEnvironmentId: options.environmentId ?? laptop,
            exchangeRole: exchangeId === null ? "none" : "ask",
            envelopeChannel: "peer",
          },
          createdAt: timestamp,
        },
      ],
    });
    return { messageId: `message:${name}`, exchangeId };
  });

const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    status: (messageId: string) =>
      sql<{ readonly status: string }>`
        SELECT status FROM j5_a2a_delivery WHERE message_id = ${messageId}
      `.pipe(Effect.map((found) => found[0]?.status)),
    exchange: (exchangeId: string) =>
      sql<{ readonly status: string }>`
        SELECT status FROM j5_a2a_exchange WHERE exchange_id = ${exchangeId}
      `.pipe(Effect.map((found) => found[0]?.status)),
    // Notices to parties here; a platform message bound for the peer is not one.
    notices: sql<{ readonly receiver_id: string; readonly message_text: string }>`
      SELECT receiver_id, message_text FROM j5_a2a_delivery
      WHERE envelope_channel = 'lifecycle_notice' AND receiver_environment_id IS NULL
      ORDER BY sent_seq
    `,
    dropCauses: sql<{ readonly exchange_id: string; readonly cause: string }>`
      SELECT exchange_id, json_extract(payload, '$.cause') AS cause FROM j5_a2a_comm_event
      WHERE kind = 'exchange.dropped' ORDER BY seq
    `.pipe(
      Effect.map((found) =>
        found.map((row) => ({ exchangeId: row.exchange_id, cause: JSON.parse(row.cause) })),
      ),
    ),
    noticeStatuses: sql<{ readonly status: string }>`
      SELECT status FROM j5_a2a_delivery
      WHERE envelope_channel = 'lifecycle_notice' AND receiver_environment_id IS NULL
      ORDER BY sent_seq
    `.pipe(Effect.map((found) => found.map((row) => row.status))),
    waitingForLaptop: sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM j5_a2a_delivery
      WHERE receiver_environment_id = ${laptop}
        AND status IN ('pending', 'retry_scheduled', 'alarmed')
    `.pipe(Effect.map((found) => Number(found[0]?.count))),
    peerCount: sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM j5_a2a_peer WHERE environment_id = ${laptop}
    `.pipe(Effect.map((found) => Number(found[0]?.count))),
    grantCount: sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM j5_a2a_peer_store_grant WHERE environment_id = ${laptop}
    `.pipe(Effect.map((found) => Number(found[0]?.count))),
  };
});

it.effect(
  "cancels what waits for a removed peer and drops its open Exchanges, telling each party here once",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const read = yield* rows;
      const worker = yield* A2ADeliveryWorker;

      // Waiting for the laptop: a message never handed out, and an ask it was handed.
      const plain = yield* sendFromBilling("plain");
      const ask = yield* sendFromBilling("ask", { ask: true });
      yield* worker.handOutToPeer(laptop);
      // A message the laptop refused: its sender was told then.
      const refused = yield* sendFromBilling("refused");
      yield* worker.handOutToPeer(laptop);
      yield* worker.acknowledgePeer(laptop, [
        {
          messageId: refused.messageId,
          outcome: "refused",
          code: "recipient_not_found",
          message: "No such agent",
        },
      ]);
      // An ask from the laptop's agent that billing owes an answer to.
      const inbound = yield* PeerInboundService;
      yield* inbound.receive({
        messageId: "message:from-laptop",
        senderId: iosBuild,
        receiverId: billing.id,
        exchangeId: "exchange:from-laptop",
        correlationId: "correlation:from-laptop",
        exchangeRole: "ask",
        intent: "schema status",
        envelopeChannel: "peer",
        text: "Is the billing schema migrated?",
        originSquadronId: laptopSquadron,
        createdAt: timestamp,
        originEnvironmentId: laptop,
      });
      // And a message for another peer, which this removal leaves alone.
      const elsewhere = yield* sendFromBilling("elsewhere", { environmentId: otherPeer });
      const toldBefore = (yield* read.notices).length;
      assert.equal(toldBefore, 1, "the refusal's notice");

      const removal = yield* PeerRemovalService;
      const result = yield* removal.remove(laptop);
      assert.deepStrictEqual(result, { removed: true, cancelledMessages: 3, droppedExchanges: 2 });

      for (const messageId of [plain.messageId, ask.messageId, refused.messageId]) {
        assert.equal(yield* read.status(messageId), "cancelled", messageId);
      }
      assert.equal(yield* read.status(elsewhere.messageId), "pending");
      assert.equal(yield* read.exchange(ask.exchangeId!), "dropped");
      assert.equal(yield* read.exchange("exchange:from-laptop"), "dropped");
      assert.deepStrictEqual(
        yield* read.dropCauses,
        [
          {
            exchangeId: ask.exchangeId!,
            cause: { kind: "peer-removed", participantId: iosBuild, projectId: laptopSquadron },
          },
          {
            exchangeId: "exchange:from-laptop",
            cause: { kind: "peer-removed", participantId: iosBuild, projectId: laptopSquadron },
          },
        ],
        "each drop names the party on the removed peer",
      );

      const told = (yield* read.notices).slice(toldBefore);
      assert.deepStrictEqual(
        told.map((notice) => notice.receiver_id),
        [billing.id, billing.id, billing.id],
        "the ask's drop, the laptop's ask's drop, and the plain message; nothing again for the refusal",
      );
      assert.include(
        told[0]!.message_text,
        "ended because JM-LT-04213 is no longer peered (receiver-retired)",
      );
      assert.include(
        told[1]!.message_text,
        "ended because JM-LT-04213 is no longer peered (sender-retired)",
      );
      assert.include(
        told[2]!.message_text,
        `Your message to ${iosBuild} on JM-LT-04213 may not have been delivered: JM-LT-04213 is no longer peered.`,
        "it was handed to the laptop, which may have taken it",
      );
      assert.equal(yield* read.peerCount, 0);
      assert.equal(yield* read.grantCount, 0);

      // Removing again finds nothing left to do.
      assert.deepStrictEqual(yield* removal.remove(laptop), {
        removed: false,
        cancelledMessages: 0,
        droppedExchanges: 0,
      });
      assert.equal((yield* read.notices).length, toldBefore + 3);
    }).pipe(Effect.provide(makeTestLayer())),
);

it.effect(
  "leaves a message the peer took as removal began delivered, and tells no one otherwise",
  () =>
    Effect.gen(function* () {
      const sending = yield* Deferred.make<void>();
      const answered = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        yield* seed();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
        UPDATE j5_a2a_peer
        SET link_mode = 'push', origin = 'https://laptop.example', credential = 'laptop-token'
        WHERE environment_id = ${laptop}
      `;
        const read = yield* rows;
        const plain = yield* sendFromBilling("plain");
        // The laptop is taking the message when the removal begins, and accepts it after.
        const attempt = yield* Effect.forkChild((yield* A2ADeliveryWorker).runOnce);
        yield* Deferred.await(sending);
        // The removal either waits for the attempt or cancels under it; the first receipt says which.
        const committed = yield* (yield* A2ALedger).subscribeCommitted;
        const removalFirst = yield* Effect.forkChild(
          Effect.raceFirst(
            Deferred.await(waiting).pipe(Effect.as("waits for the attempt" as const)),
            committed.pipe(
              Stream.filter((event) => event.kind === "message.cancelled"),
              Stream.runHead,
              Effect.as("cancelled under the attempt" as const),
            ),
          ),
        );
        const removal = yield* Effect.forkChild((yield* PeerRemovalService).remove(laptop));
        assert.equal(yield* Fiber.join(removalFirst), "waits for the attempt");
        yield* Deferred.succeed(answered, undefined);

        assert.equal((yield* Fiber.join(attempt))?.state, "delivered");
        // It read the row as waiting before the receipt, and found it delivered when it decided.
        assert.equal((yield* Fiber.join(removal)).cancelledMessages, 0);
        assert.equal(yield* read.status(plain.messageId), "delivered");
        assert.deepStrictEqual(yield* read.notices, [], "its sender is told nothing");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          makeTestLayer({
            deliverPeer: () =>
              Deferred.succeed(sending, undefined).pipe(Effect.andThen(Deferred.await(answered))),
            waitsForDrain: Deferred.succeed(waiting, undefined).pipe(Effect.asVoid),
          }),
        ),
      );
    }),
);

it.effect("tells the sender of a follow-up on a dropped Exchange once, by the drop", () =>
  Effect.gen(function* () {
    yield* seed();
    const read = yield* rows;
    const ask = yield* sendFromBilling("ask", { ask: true });
    yield* (yield* A2ALedger).appendEvents({
      commandId: CommCommandId.make("command:peer-removal:followup"),
      squadronId: vmSquadron,
      acceptedAt: timestamp,
      events: [
        {
          kind: "message.sent",
          sender: billing.id,
          receiver: iosBuild,
          exchangeId: ask.exchangeId,
          correlationId: CorrelationId.make("correlation:ask"),
          payload: {
            messageId: LedgerMessageId.make("message:followup"),
            text: "One more detail.",
            originProjectId: vmSquadron,
            receiverProjectId: laptopSquadron,
            receiverEnvironmentId: laptop,
            exchangeRole: "followup",
            envelopeChannel: "peer",
          },
          createdAt: timestamp,
        },
      ],
    });

    const result = yield* (yield* PeerRemovalService).remove(laptop);
    assert.deepStrictEqual(result, { removed: true, cancelledMessages: 2, droppedExchanges: 1 });
    assert.equal(yield* read.status("message:followup"), "cancelled");
    const told = yield* read.notices;
    assert.equal(told.length, 1, "the drop's notice only");
    assert.include(told[0]!.message_text, "exchange dropped");
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("wipes the slate the same way for a peer this server sends to or polls", () =>
  Effect.gen(function* () {
    for (const linkMode of ["push", "poll"] as const) {
      yield* Effect.gen(function* () {
        yield* seed();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          UPDATE j5_a2a_peer
          SET link_mode = ${linkMode}, origin = 'https://laptop.example', credential = 'laptop-token'
          WHERE environment_id = ${laptop}
        `;
        const read = yield* rows;
        const plain = yield* sendFromBilling("plain");
        const ask = yield* sendFromBilling("ask", { ask: true });
        // A direct send that failed once waits to retry.
        yield* sql`UPDATE j5_a2a_delivery SET status = 'retry_scheduled' WHERE message_id = ${plain.messageId}`;

        const result = yield* (yield* PeerRemovalService).remove(laptop);
        assert.deepStrictEqual(result, {
          removed: true,
          cancelledMessages: 2,
          droppedExchanges: 1,
        });
        assert.equal(yield* read.status(plain.messageId), "cancelled", linkMode);
        assert.equal(yield* read.status(ask.messageId), "cancelled", linkMode);
        assert.equal(yield* read.exchange(ask.exchangeId!), "dropped", linkMode);
        assert.equal((yield* read.notices).length, 2, `${linkMode}: one drop, one not-delivered`);
      }).pipe(Effect.provide(makeTestLayer()));
    }
  }),
);

/** The laptop recorded again after a removal, in the mode it had: a new record. */
const peerAgain = (linkMode: "store" | "push" | "poll") =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    linkMode === "store"
      ? sql`
          INSERT INTO j5_a2a_peer (environment_id, label, link_mode, created_at, updated_at)
          VALUES (${laptop}, 'JM-LT-04213', 'store', '2026-10-02T13:00:00.000Z', '2026-10-02T13:00:00.000Z')
        `
      : sql`
          INSERT INTO j5_a2a_peer (environment_id, label, link_mode, origin, credential, created_at, updated_at)
          VALUES (${laptop}, 'JM-LT-04213', ${linkMode}, 'https://laptop.example', 'laptop-token-2',
            '2026-10-02T13:00:00.000Z', '2026-10-02T13:00:00.000Z')
        `,
  );

it.effect("starts empty when the pair is peered again, in every mode", () =>
  Effect.gen(function* () {
    for (const linkMode of ["store", "push", "poll"] as const) {
      yield* Effect.gen(function* () {
        yield* seed();
        const sql = yield* SqlClient.SqlClient;
        if (linkMode !== "store") {
          yield* sql`
            UPDATE j5_a2a_peer
            SET link_mode = ${linkMode}, origin = 'https://laptop.example', credential = 'laptop-token'
            WHERE environment_id = ${laptop}
          `;
        }
        const read = yield* rows;
        const worker = yield* A2ADeliveryWorker;
        // Waiting, handed out (for a store peer), alarmed, and an open Exchange the laptop opened.
        const plain = yield* sendFromBilling("plain");
        const ask = yield* sendFromBilling("ask", { ask: true });
        if (linkMode === "store") yield* worker.handOutToPeer(laptop);
        const alarmed = yield* sendFromBilling("alarmed");
        yield* sql`UPDATE j5_a2a_delivery SET status = 'alarmed' WHERE message_id = ${alarmed.messageId}`;
        yield* (yield* PeerInboundService).receive({
          messageId: "message:from-laptop",
          senderId: iosBuild,
          receiverId: billing.id,
          exchangeId: "exchange:from-laptop",
          correlationId: "correlation:from-laptop",
          exchangeRole: "ask",
          intent: "schema status",
          envelopeChannel: "peer",
          text: "Is the billing schema migrated?",
          originSquadronId: laptopSquadron,
          createdAt: timestamp,
          originEnvironmentId: laptop,
        });

        yield* (yield* PeerRemovalService).remove(laptop);
        yield* peerAgain(linkMode);

        assert.equal(
          yield* read.waitingForLaptop,
          0,
          `${linkMode}: nothing waits for the new record`,
        );
        if (linkMode === "store") {
          assert.deepStrictEqual((yield* worker.handOutToPeer(laptop)).deliveries, []);
        }
        for (const messageId of [plain.messageId, ask.messageId, alarmed.messageId]) {
          assert.equal(yield* read.status(messageId), "cancelled", `${linkMode}: ${messageId}`);
        }
        assert.equal(yield* read.exchange(ask.exchangeId!), "dropped", linkMode);
        assert.equal(yield* read.exchange("exchange:from-laptop"), "dropped", linkMode);

        // What is sent after peering again travels; nothing from before goes with it.
        const fresh = yield* sendFromBilling("fresh");
        assert.equal(yield* read.status(fresh.messageId), "pending", linkMode);
        if (linkMode === "store") {
          assert.deepStrictEqual(
            (yield* worker.handOutToPeer(laptop)).deliveries.map((delivery) => delivery.messageId),
            [fresh.messageId],
          );
        }
      }).pipe(Effect.provide(makeTestLayer()));
    }
  }),
);

it.effect("sends no notice back for a platform message the peer refuses or removal cancels", () =>
  Effect.gen(function* () {
    yield* seed();
    const ledger = yield* A2ALedger;
    const worker = yield* A2ADeliveryWorker;
    const read = yield* rows;
    // A lifecycle notice on its way to the laptop's agent, as an archive here queues one.
    const platformNotice = (name: string) =>
      ledger.append({
        commandId: CommCommandId.make(`command:peer-removal:platform:${name}`),
        squadronId: vmSquadron,
        acceptedAt: timestamp,
        event: {
          kind: "message.sent",
          sender: LIFECYCLE_PARTICIPANT_ID,
          receiver: iosBuild,
          exchangeId: null,
          correlationId: CorrelationId.make(`correlation:platform:${name}`),
          payload: {
            messageId: LedgerMessageId.make(`message:platform:${name}`),
            text: `${name} notice`,
            originProjectId: vmSquadron,
            receiverProjectId: laptopSquadron,
            receiverEnvironmentId: laptop,
            exchangeRole: "none",
            envelopeChannel: "lifecycle_notice",
          },
          createdAt: timestamp,
        },
      });
    yield* platformNotice("refused");
    yield* worker.handOutToPeer(laptop);
    yield* worker.acknowledgePeer(laptop, [
      {
        messageId: "message:platform:refused",
        outcome: "refused",
        code: "recipient_not_found",
        message: "No such agent",
      },
    ]);
    assert.equal(yield* read.status("message:platform:refused"), "alarmed");
    yield* platformNotice("cancelled");
    yield* (yield* PeerRemovalService).remove(laptop);
    assert.equal(yield* read.status("message:platform:cancelled"), "cancelled");
    assert.deepStrictEqual(
      yield* read.notices,
      [],
      "a platform sender is told nothing, so nothing loops",
    );
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("sends no notice back to a machine sender when removal cancels its message", () =>
  Effect.gen(function* () {
    yield* seed();
    const ledger = yield* A2ALedger;
    const read = yield* rows;
    yield* ledger.append({
      commandId: CommCommandId.make("command:peer-removal:join-watchdog"),
      squadronId: vmSquadron,
      acceptedAt: timestamp,
      event: {
        kind: "participant.joined",
        sender: null,
        receiver: watchdog.id,
        exchangeId: null,
        correlationId: null,
        payload: { participant: watchdog },
        createdAt: timestamp,
      },
    });
    const fromWatchdog = yield* sendFromBilling("watchdog", { sender: watchdog.id });
    yield* (yield* PeerRemovalService).remove(laptop);
    assert.equal(yield* read.status(fromWatchdog.messageId), "cancelled");
    assert.deepStrictEqual(yield* read.notices, [], "a machine sender has no thread to tell");
  }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("delivers removal's notices at once, with nothing else to wake the worker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed();
      const read = yield* rows;
      const worker = yield* A2ADeliveryWorker;
      const milestones = yield* worker.subscribeMilestones;
      const deliveredNext = (pattern: RegExp, count: number) =>
        milestones.pipe(
          Stream.filter(
            (milestone) => milestone.state === "delivered" && pattern.test(milestone.messageId),
          ),
          Stream.take(count),
          Stream.runCollect,
        );
      const ask = yield* sendFromBilling("ask", { ask: true });
      yield* sendFromBilling("plain");
      yield* worker.handOutToPeer(laptop);
      // The laptop's agent asks billing, delivered as the deliver route does it. Once
      // that arrives the worker has nothing left to do, and sleeps until woken.
      yield* (yield* PeerInboundService).receive({
        messageId: "message:from-laptop",
        senderId: iosBuild,
        receiverId: billing.id,
        exchangeId: "exchange:from-laptop",
        correlationId: "correlation:from-laptop",
        exchangeRole: "ask",
        intent: "schema status",
        envelopeChannel: "peer",
        text: "Is the billing schema migrated?",
        originSquadronId: laptopSquadron,
        createdAt: timestamp,
        originEnvironmentId: laptop,
      });
      yield* worker.notify;
      yield* deliveredNext(/from-laptop/, 1);
      // drain shares the daemon's permit, so this returns once the daemon's own
      // drain is done; yielding lets it go back to waiting for a wake.
      yield* worker.drain;
      yield* Effect.yieldNow;

      yield* (yield* PeerRemovalService).remove(laptop);
      // Only the removal wakes it now: billing's three notices arrive.
      const delivered = yield* deliveredNext(/:(not-delivered|peer-drop):/, 3);
      assert.equal(delivered.length, 3);
      assert.equal(yield* read.exchange(ask.exchangeId!), "dropped");
      assert.equal(yield* read.exchange("exchange:from-laptop"), "dropped");
      assert.deepStrictEqual(yield* read.noticeStatuses, ["delivered", "delivered", "delivered"]);
    }),
  ).pipe(Effect.provide(makeTestLayer({ delivering: true }))),
);
