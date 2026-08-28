import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import {
  A2ADeliveryHookError,
  A2ADeliveryHooks,
  A2ADeliveryWorker,
  layerWithHooks as deliveryWorkerLayerWithHooks,
} from "./DeliveryWorker.ts";
import {
  A2ADeliveryTransport,
  A2ADeliveryTransportError,
  deliveryCommandId,
  deliveryMessageId,
  live as deliveryTransportLive,
  type A2ADeliveryTransportShape,
} from "./DeliveryTransport.ts";
import { A2AHumanInbox, layer as humanInboxLayer } from "./HumanInboxService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { A2ASendService, layer as sendLayer } from "./SendService.ts";
import { CommCommandId, SquadronId, ParticipantId, type AgentParticipant } from "./contracts.ts";

const timestamp = "2026-08-16T12:00:00.000Z";
const sender: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:delivery-sender"),
  threadId: ThreadId.make("thread:delivery-sender"),
};
const receiver: AgentParticipant = {
  kind: "agent",
  id: ParticipantId.make("agent:delivery-receiver"),
  threadId: ThreadId.make("thread:delivery-receiver"),
};
const person = {
  kind: "human" as const,
  id: ParticipantId.make("human:delivery-person"),
};

const makeTestLayer = (
  transport: A2ADeliveryTransportShape,
  hooks: A2ADeliveryHooks["Service"] = A2ADeliveryHooks.of({
    afterTransportSuccess: () => Effect.void,
  }),
) => {
  const database = NodeSqliteClient.layerMemory();
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const send = sendLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  const transportLayer = Layer.succeed(A2ADeliveryTransport, A2ADeliveryTransport.of(transport));
  const worker = deliveryWorkerLayerWithHooks(false).pipe(
    Layer.provide(ledger),
    Layer.provide(database),
    Layer.provide(transportLayer),
    Layer.provide(Layer.succeed(A2ADeliveryHooks, hooks)),
  );
  return Layer.mergeAll(database, ledger, send, transportLayer, worker);
};

const join = Effect.fn("test.j5.a2a.delivery.join")(function* (
  squadronId: SquadronId,
  participant: AgentParticipant,
  index: string,
) {
  yield* (yield* A2ALedger).append({
    commandId: CommCommandId.make(`command:delivery:join:${index}`),
    squadronId,
    acceptedAt: timestamp,
    event: {
      kind: "participant.joined",
      sender: null,
      receiver: participant.id,
      exchangeId: null,
      correlationId: null,
      payload: { participant },
      createdAt: timestamp,
    },
  });
});

const seedSend = Effect.fn("test.j5.a2a.delivery.seedSend")(function* (crossSquadron: boolean) {
  yield* runJ5A2AMigrations();
  const ledgerService = yield* A2ALedger;
  const senderSquadronId = SquadronId.make("squadron:delivery:sender");
  const receiverSquadronId = crossSquadron
    ? SquadronId.make("squadron:delivery:receiver")
    : senderSquadronId;
  yield* ledgerService.createSquadron({
    squadron: { id: senderSquadronId, name: "Delivery sender", createdAt: timestamp },
  });
  if (crossSquadron) {
    yield* ledgerService.createSquadron({
      squadron: { id: receiverSquadronId, name: "Delivery receiver", createdAt: timestamp },
    });
  }
  yield* join(senderSquadronId, sender, "sender");
  yield* join(receiverSquadronId, receiver, "receiver");
  const sent = yield* (yield* A2ASendService).send({
    commandId: CommCommandId.make(
      crossSquadron ? "command:delivery:cross-squadron" : "command:delivery:same-squadron",
    ),
    senderThreadId: sender.threadId,
    to: receiver.id,
    message: "Delivery crash-window probe",
    acceptedAt: timestamp,
  });
  return { senderSquadronId, receiverSquadronId, sent };
});

const crashWindowScenario = (poisonIds: boolean, crossSquadron: boolean) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const injections = yield* Ref.make(0);
    const seen = yield* Ref.make(new Set<string>());
    const hookCalls = yield* Ref.make(0);
    const transport: A2ADeliveryTransportShape = {
      deliverAgent: (input) =>
        Effect.gen(function* () {
          const call = yield* Ref.updateAndGet(calls, (count) => count + 1);
          const stableKey = `${deliveryCommandId(input.messageId)}:${deliveryMessageId(input.messageId)}`;
          const key = poisonIds ? `${stableKey}:attempt:${call}` : stableKey;
          const inserted = yield* Ref.modify(seen, (keys) => {
            if (keys.has(key)) return [false, keys] as const;
            const next = new Set(keys);
            next.add(key);
            return [true, next] as const;
          });
          if (inserted) yield* Ref.update(injections, (count) => count + 1);
        }).pipe(
          Effect.mapError(
            (cause) => new A2ADeliveryTransportError({ operation: "test delivery", cause }),
          ),
        ),
      deliverHuman: () => Effect.void,
    };
    const hooks = A2ADeliveryHooks.of({
      afterTransportSuccess: () =>
        Ref.updateAndGet(hookCalls, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 1
              ? Effect.fail(
                  new A2ADeliveryHookError({
                    cause: "simulated crash after injection before delivery receipt",
                  }),
                )
              : Effect.void,
          ),
        ),
    });

    const result = yield* Effect.gen(function* () {
      const { receiverSquadronId, sent } = yield* seedSend(crossSquadron);
      const worker = yield* A2ADeliveryWorker;
      const sql = yield* SqlClient.SqlClient;
      if (crossSquadron) {
        const before = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM j5_a2a_comm_event
          WHERE squadron_id = ${receiverSquadronId} AND kind = 'message.received'
        `;
        assert.equal(before[0]?.count, 0, "sender commit precedes receiver double-entry");
        const senderState = yield* sql<{ readonly status: string }>`
          SELECT status
          FROM j5_a2a_delivery
          WHERE message_id = ${sent.messageId}
        `;
        assert.deepStrictEqual(senderState, [{ status: "pending" }]);
      }

      const first = yield* worker.runOnce;
      assert.equal(first?.state, "retry_scheduled");
      assert.equal(first?.attempt, 1);
      yield* TestClock.adjust("250 millis");
      const replay = yield* worker.runOnce;
      assert.equal(replay?.state, "delivered");
      assert.equal(replay?.attempt, 2);

      const received = crossSquadron
        ? yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM j5_a2a_comm_event
            WHERE squadron_id = ${receiverSquadronId}
              AND kind = 'message.received'
              AND correlation_id IS NOT NULL
          `
        : [{ count: 0 }];
      const senderState = yield* sql<{ readonly status: string }>`
        SELECT status
        FROM j5_a2a_delivery
        WHERE message_id = ${sent.messageId}
      `;
      return {
        messageId: sent.messageId,
        injectionCount: yield* Ref.get(injections),
        receivedCount: received[0]?.count ?? 0,
        senderState: senderState[0]?.status,
      };
    }).pipe(Effect.provide(makeTestLayer(transport, hooks)));
    return result;
  });

it.effect("recovers the injected-but-unrecorded window with one upstream injection", () =>
  Effect.gen(function* () {
    const result = yield* crashWindowScenario(false, false);
    assert.equal(result.injectionCount, 1);
  }),
);

it.effect("negative control: poisoned retry ids are detected as a double injection", () =>
  Effect.gen(function* () {
    const poisoned = yield* crashWindowScenario(true, false);
    assert.equal(poisoned.injectionCount, 2);
    assert.notEqual(poisoned.injectionCount, 1);
  }),
);

it.effect("serializes manual runOnce calls against a concurrent drain", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const firstEntered = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const transport: A2ADeliveryTransportShape = {
      deliverAgent: () =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.flatMap((call) =>
            call === 1
              ? Deferred.succeed(firstEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFirst)),
                )
              : Effect.void,
          ),
        ),
      deliverHuman: () => Effect.void,
    };

    yield* Effect.gen(function* () {
      yield* seedSend(false);
      const worker = yield* A2ADeliveryWorker;
      const runOnceFiber = yield* worker.runOnce.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(firstEntered);
      const drainFiber = yield* worker.drain.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(calls), 1, "drain cannot claim the in-flight delivery");

      yield* Deferred.succeed(releaseFirst, undefined);
      assert.equal((yield* Fiber.join(runOnceFiber))?.state, "delivered");
      assert.deepStrictEqual(yield* Fiber.join(drainFiber), []);
      assert.equal(yield* Ref.get(calls), 1);
    }).pipe(Effect.provide(makeTestLayer(transport)));
  }),
);

it.effect("cross-squadron half-write recovery records exactly one receiver entry", () =>
  Effect.gen(function* () {
    const result = yield* crashWindowScenario(false, true);
    assert.equal(result.injectionCount, 1);
    assert.equal(result.receivedCount, 1);
    assert.equal(result.senderState, "delivered");
  }),
);

it.effect("closes a cross-squadron exchange through the paired reply entry", () =>
  Effect.gen(function* () {
    const injections = yield* Ref.make(0);
    const transport: A2ADeliveryTransportShape = {
      deliverAgent: () => Ref.update(injections, (count) => count + 1),
      deliverHuman: () => Effect.void,
    };
    yield* Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const ledgerService = yield* A2ALedger;
      const sendService = yield* A2ASendService;
      const worker = yield* A2ADeliveryWorker;
      const sql = yield* SqlClient.SqlClient;
      const senderSquadronId = SquadronId.make("squadron:exchange:sender");
      const receiverSquadronId = SquadronId.make("squadron:exchange:receiver");
      yield* ledgerService.createSquadron({
        squadron: { id: senderSquadronId, name: "Exchange sender", createdAt: timestamp },
      });
      yield* ledgerService.createSquadron({
        squadron: { id: receiverSquadronId, name: "Exchange receiver", createdAt: timestamp },
      });
      yield* join(senderSquadronId, sender, "exchange-sender");
      yield* join(receiverSquadronId, receiver, "exchange-receiver");

      const opened = yield* sendService.send({
        commandId: CommCommandId.make("command:exchange:cross:open"),
        senderThreadId: sender.threadId,
        to: receiver.id,
        message: "Please reply across squadrons.",
        expectReply: true,
        intent: "Prove cross-squadron reply closure",
        acceptedAt: timestamp,
      });
      assert.equal(opened.exchangeState, "open");
      assert.equal((yield* worker.runOnce)?.state, "delivered");

      const replyInput = {
        commandId: CommCommandId.make("command:exchange:cross:reply"),
        senderThreadId: receiver.threadId,
        to: sender.id,
        message: "Cross-squadron reply delivered.",
        exchangeId: opened.exchangeId!,
        acceptedAt: timestamp,
      } as const;
      const reply = yield* sendService.send(replyInput);
      assert.equal(reply.exchangeState, "closing");

      const duplicateReply = yield* Effect.flip(
        sendService.send({
          ...replyInput,
          commandId: CommCommandId.make("command:exchange:cross:duplicate-reply"),
        }),
      );
      assert.equal(duplicateReply._tag, "A2AExchangeAlreadyAnsweredError");
      assert.equal((yield* worker.runOnce)?.state, "delivered");

      const replay = yield* sendService.send(replyInput);
      assert.deepStrictEqual(replay, reply, "command replay preserves its pre-delivery result");
      const exchange = yield* sql<{ readonly status: string }>`
        SELECT status
        FROM j5_a2a_exchange
        WHERE exchange_id = ${opened.exchangeId!}
      `;
      assert.deepStrictEqual(exchange, [{ status: "closed" }]);
      const paired = yield* sql<{ readonly squadron_id: string; readonly count: number }>`
        SELECT squadron_id, COUNT(*) AS count
        FROM j5_a2a_comm_event
        WHERE kind = 'message.received'
          AND squadron_id IN (${senderSquadronId}, ${receiverSquadronId})
        GROUP BY squadron_id
        ORDER BY squadron_id
      `;
      assert.deepStrictEqual(
        paired,
        [
          { squadron_id: receiverSquadronId, count: 1 },
          { squadron_id: senderSquadronId, count: 1 },
        ].sort((left, right) => left.squadron_id.localeCompare(right.squadron_id)),
      );
      const pairedPayloads = yield* sql<{
        readonly squadron_id: string;
        readonly payload: string;
      }>`
        SELECT squadron_id, payload
        FROM j5_a2a_comm_event
        WHERE kind = 'message.received'
          AND squadron_id IN (${senderSquadronId}, ${receiverSquadronId})
        ORDER BY squadron_id
      `;
      assert.deepStrictEqual(
        pairedPayloads.map((row) => {
          const payload = JSON.parse(row.payload) as {
            message: { envelopeChannel: string; exchangeRole: string };
          };
          return {
            squadronId: row.squadron_id,
            message: {
              envelopeChannel: payload.message.envelopeChannel,
              exchangeRole: payload.message.exchangeRole,
            },
          };
        }),
        [
          {
            squadronId: receiverSquadronId,
            message: { envelopeChannel: "peer", exchangeRole: "ask" },
          },
          {
            squadronId: senderSquadronId,
            message: { envelopeChannel: "peer", exchangeRole: "reply" },
          },
        ].sort((left, right) => left.squadronId.localeCompare(right.squadronId)),
      );
      assert.equal(yield* Ref.get(injections), 2);
    }).pipe(Effect.provide(makeTestLayer(transport)));
  }),
);

it.effect("startup reconciliation drains a persisted cross-squadron half-write after restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j5-a2a-restart-" });
      const filename = path.join(directory, "state.sqlite");
      const firstDatabase = NodeSqliteClient.layer({ filename });
      const firstLedger = ledgerLayer.pipe(Layer.provide(firstDatabase));
      const firstSend = sendLayer.pipe(Layer.provide(firstLedger), Layer.provide(firstDatabase));
      const firstLayer = Layer.mergeAll(firstDatabase, firstLedger, firstSend);
      const persisted = yield* Effect.scoped(
        Effect.gen(function* () {
          const seeded = yield* seedSend(true);
          const sql = yield* SqlClient.SqlClient;
          const received = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM j5_a2a_comm_event
            WHERE squadron_id = ${seeded.receiverSquadronId} AND kind = 'message.received'
          `;
          assert.equal(received[0]?.count, 0);
          return seeded;
        }).pipe(Effect.provide(firstLayer)),
      );

      const injectionCount = yield* Ref.make(0);
      const transportEntered = yield* Deferred.make<void>();
      const releaseTransport = yield* Deferred.make<void>();
      const transport: A2ADeliveryTransportShape = {
        deliverAgent: () => Ref.update(injectionCount, (count) => count + 1),
        deliverHuman: () => Effect.void,
      };
      const secondDatabase = NodeSqliteClient.layer({ filename });
      const secondLedger = ledgerLayer.pipe(Layer.provide(secondDatabase));
      const secondTransport = Layer.succeed(
        A2ADeliveryTransport,
        A2ADeliveryTransport.of(transport),
      );
      const secondWorker = deliveryWorkerLayerWithHooks(true).pipe(
        Layer.provide(secondLedger),
        Layer.provide(secondDatabase),
        Layer.provide(secondTransport),
        Layer.provide(
          Layer.succeed(
            A2ADeliveryHooks,
            A2ADeliveryHooks.of({
              afterTransportSuccess: () =>
                Deferred.succeed(transportEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseTransport)),
                ),
            }),
          ),
        ),
      );
      const secondLayer = Layer.mergeAll(
        secondDatabase,
        secondLedger,
        secondTransport,
        secondWorker,
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* A2ADeliveryWorker;
          yield* Deferred.await(transportEntered);
          const milestoneStream = yield* worker.subscribeMilestones;
          const milestoneFiber = yield* milestoneStream.pipe(
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.succeed(releaseTransport, undefined);
          const reconciled = yield* Fiber.join(milestoneFiber).pipe(Effect.map(Option.getOrThrow));
          assert.equal(reconciled?.state, "delivered");
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM j5_a2a_comm_event
            WHERE squadron_id = ${persisted.receiverSquadronId}
              AND kind = 'message.received'
          `;
          assert.equal(rows[0]?.count, 1);
          assert.equal(yield* Ref.get(injectionCount), 1);
        }).pipe(Effect.provide(secondLayer)),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("forces repeated delivery failure into a visible alarm", () =>
  Effect.gen(function* () {
    const failure = new A2ADeliveryTransportError({
      operation: "forced failure",
      cause: "recipient unavailable",
    });
    const transport: A2ADeliveryTransportShape = {
      deliverAgent: () => Effect.fail(failure),
      deliverHuman: () => Effect.fail(failure),
    };
    yield* Effect.gen(function* () {
      yield* seedSend(false);
      const worker = yield* A2ADeliveryWorker;
      assert.equal((yield* worker.runOnce)?.state, "retry_scheduled");
      yield* TestClock.adjust("250 millis");
      assert.equal((yield* worker.runOnce)?.state, "retry_scheduled");
      yield* TestClock.adjust("500 millis");
      const alarm = yield* worker.runOnce;
      assert.equal(alarm?.state, "alarmed");
      assert.equal(alarm?.attempt, 3);
      const alarms = yield* worker.listAlarms;
      assert.lengthOf(alarms, 1);
      assert.equal(alarms[0]?.messageId, alarm?.messageId);
      assert.include(alarms[0]?.lastError ?? "", "recipient unavailable");
    }).pipe(Effect.provide(makeTestLayer(transport)));
  }),
);

it.effect("delivers to the human through the idempotent inbox-data transport", () =>
  Effect.gen(function* () {
    const database = NodeSqliteClient.layerMemory();
    const ledger = ledgerLayer.pipe(Layer.provide(database));
    const send = sendLayer.pipe(Layer.provide(ledger), Layer.provide(database));
    const threadManagement = Layer.mock(ThreadManagementService)({});
    const transport = deliveryTransportLive.pipe(
      Layer.provide(database),
      Layer.provide(threadManagement),
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
    const layer = Layer.mergeAll(database, ledger, send, transport, worker);

    yield* Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const ledgerService = yield* A2ALedger;
      const squadronId = SquadronId.make("squadron:delivery:human");
      yield* ledgerService.createSquadron({
        squadron: { id: squadronId, name: "Human delivery", createdAt: timestamp },
      });
      yield* join(squadronId, sender, "human-sender");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
        VALUES (${person.id}, 1, ${timestamp})
      `;
      const sent = yield* (yield* A2ASendService).send({
        commandId: CommCommandId.make("command:delivery:human"),
        senderThreadId: sender.threadId,
        to: person.id,
        message: "Human inbox payload",
        expectReply: true,
        intent: "Obtain a human answer",
        urgency: "soon",
        acceptedAt: timestamp,
      });
      const delivery = yield* (yield* A2ADeliveryWorker).runOnce;
      assert.equal(delivery?.state, "delivered");

      const rows = yield* sql<{
        readonly message_id: string;
        readonly payload: string;
        readonly receiver_id: string;
      }>`
        SELECT message_id, payload, receiver_id
        FROM j5_a2a_human_inbox_data
        WHERE origin_squadron_id = ${squadronId}
      `;
      assert.deepStrictEqual(rows, [
        {
          message_id: sent.messageId,
          payload: "Human inbox payload",
          receiver_id: person.id,
        },
      ]);
      const inbox = yield* sql<{
        readonly person_id: string;
        readonly exchange_id: string;
        readonly status: string;
        readonly urgency: string;
      }>`
        SELECT person_id, exchange_id, status, urgency
        FROM j5_a2a_human_inbox
      `;
      assert.deepStrictEqual(inbox, [
        {
          person_id: person.id,
          exchange_id: sent.exchangeId!,
          status: "open",
          urgency: "soon",
        },
      ]);
      assert.isNull(yield* (yield* A2ADeliveryWorker).runOnce);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("treats a follow-up delivered after the human answered as a successful no-op", () =>
  Effect.gen(function* () {
    const database = NodeSqliteClient.layerMemory();
    const ledger = ledgerLayer.pipe(Layer.provide(database));
    const send = sendLayer.pipe(Layer.provide(ledger), Layer.provide(database));
    const inbox = humanInboxLayer.pipe(Layer.provide(ledger), Layer.provide(database));
    const transport = deliveryTransportLive.pipe(
      Layer.provide(database),
      Layer.provide(Layer.mock(ThreadManagementService)({})),
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
    const layer = Layer.mergeAll(database, ledger, send, inbox, transport, worker);

    yield* Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const ledgerService = yield* A2ALedger;
      const sendService = yield* A2ASendService;
      const deliveryWorker = yield* A2ADeliveryWorker;
      const sql = yield* SqlClient.SqlClient;
      const squadronId = SquadronId.make("squadron:delivery:human-followup-race");
      yield* ledgerService.createSquadron({
        squadron: { id: squadronId, name: "Human follow-up race", createdAt: timestamp },
      });
      yield* join(squadronId, sender, "human-followup-race-sender");
      yield* sql`
        INSERT INTO j5_a2a_human_person (person_id, is_local_operator, created_at)
        VALUES (${person.id}, 1, ${timestamp})
      `;
      const opened = yield* sendService.send({
        commandId: CommCommandId.make("command:delivery:human-followup-race:open"),
        senderThreadId: sender.threadId,
        to: person.id,
        message: "Initial question",
        expectReply: true,
        intent: "Reproduce answer racing a follow-up",
        urgency: "blocking",
        acceptedAt: timestamp,
      });
      assert.equal((yield* deliveryWorker.runOnce)?.state, "delivered");

      const followup = yield* sendService.send({
        commandId: CommCommandId.make("command:delivery:human-followup-race:followup"),
        senderThreadId: sender.threadId,
        to: person.id,
        message: "Pending follow-up",
        exchangeId: opened.exchangeId!,
        acceptedAt: "2026-08-16T12:00:01.000Z",
      });
      yield* (yield* A2AHumanInbox).answer({
        commandId: CommCommandId.make("command:delivery:human-followup-race:answer"),
        personId: person.id,
        exchangeId: opened.exchangeId!,
        message: "Answered before follow-up transport",
        acceptedAt: "2026-08-16T12:00:02.000Z",
      });

      const milestone = yield* deliveryWorker.runOnce;
      assert.equal(milestone?.messageId, followup.messageId);
      assert.equal(milestone?.state, "delivered");
      const rows = yield* sql<{
        readonly attempts: number;
        readonly last_error: string | null;
        readonly status: string;
      }>`
        SELECT status, attempts, last_error
        FROM j5_a2a_delivery
        WHERE message_id = ${followup.messageId}
      `;
      assert.deepStrictEqual(rows, [{ status: "delivered", attempts: 1, last_error: null }]);
      assert.deepStrictEqual(yield* deliveryWorker.listAlarms, []);
    }).pipe(Effect.provide(layer));
  }),
);
