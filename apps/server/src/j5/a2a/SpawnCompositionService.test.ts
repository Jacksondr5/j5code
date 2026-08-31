import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { A2ADeliveryWorker, manualLayer as deliveryWorkerLayer } from "./DeliveryWorker.ts";
import { A2ADeliveryTransport, type A2ADeliveryTransportShape } from "./DeliveryTransport.ts";
import {
  A2AHomeRegistrationTransaction,
  participantIdForThread,
  layer as homeRegistrarLayer,
  transactionLayer as homeRegistrationTransactionLayer,
} from "./HomeRegistrar.ts";
import { A2ALedger, A2ALedgerTransactionWriter, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import {
  ParticipantPlacementTransactionWriter,
  layer as placementLayer,
} from "./PlacementService.ts";
import { A2ASendService, layer as sendServiceLayer } from "./SendService.ts";
import {
  SpawnCompositionService,
  layer as spawnCompositionLayer,
} from "./SpawnCompositionService.ts";
import { CommCommandId, ParticipantId, SquadronId } from "./contracts.ts";
import { PlacementCommandId } from "./placementContracts.ts";

const createdAt = "2026-08-30T16:00:00.000Z";
const database = NodeSqliteClient.layerMemory();
const ledger = ledgerLayer.pipe(Layer.provide(database));
const homes = homeRegistrarLayer.pipe(Layer.provide(ledger), Layer.provide(database));
const homeTransactions = homeRegistrationTransactionLayer.pipe(
  Layer.provide(ledger),
  Layer.provide(database),
);
const placements = placementLayer.pipe(Layer.provide(ledger), Layer.provide(database));
const composition = spawnCompositionLayer.pipe(
  Layer.provide(homeTransactions),
  Layer.provide(ledger),
  Layer.provide(placements),
  Layer.provide(database),
);
const TestLayer = Layer.mergeAll(
  database,
  ledger,
  homes,
  homeTransactions,
  placements,
  composition,
);

const seedSquadronAndSpawner = Effect.fn("test.j5.spawn.seedSquadronAndSpawner")(function* (
  squadronId: SquadronId,
  spawnerThreadId: ThreadId,
) {
  const ledgerService = yield* A2ALedger;
  const spawnerId = participantIdForThread(spawnerThreadId);
  yield* ledgerService.createSquadron({
    squadron: { id: squadronId, name: "Spawn composition", createdAt },
  });
  yield* ledgerService.append({
    commandId: CommCommandId.make(`command:seed:${spawnerId}`),
    squadronId,
    acceptedAt: createdAt,
    event: {
      kind: "participant.joined",
      sender: null,
      receiver: spawnerId,
      exchangeId: null,
      correlationId: null,
      payload: {
        participant: { kind: "agent", id: spawnerId, threadId: spawnerThreadId },
      },
      createdAt,
    },
  });
  return spawnerId;
});

const inputFor = (input: {
  readonly name: string;
  readonly squadronId: SquadronId;
  readonly threadId: ThreadId;
  readonly spawnedByParticipantId: ParticipantId;
}) => ({
  homeCommandId: CommCommandId.make(`command:spawn-home:${input.name}`),
  placementCommandId: PlacementCommandId.make(`command:spawn-placement:${input.name}`),
  squadronId: input.squadronId,
  threadId: input.threadId,
  spawnedByParticipantId: input.spawnedByParticipantId,
  createdAt,
});

it.effect("commits joined home and placement facts in one transaction", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* SpawnCompositionService;
    const sql = yield* SqlClient.SqlClient;
    const squadronId = SquadronId.make("squadron:spawn-composition:commit");
    const spawnerId = yield* seedSquadronAndSpawner(
      squadronId,
      ThreadId.make("thread:spawn-composition:spawner"),
    );
    const childThreadId = ThreadId.make("thread:spawn-composition:child");
    const ledgerService = yield* A2ALedger;
    const committed = yield* ledgerService.subscribeCommitted;
    const committedFiber = yield* committed.pipe(
      Stream.runHead,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.yieldNow;

    const input = inputFor({
      name: "commit",
      squadronId,
      threadId: childThreadId,
      spawnedByParticipantId: spawnerId,
    });
    const result = yield* service.recordFacts(input);
    const replay = yield* service.recordFacts(input);

    assert.deepStrictEqual(replay, result);
    assert.equal(result.home.participantId, participantIdForThread(childThreadId));
    assert.deepStrictEqual(result.placement.provenance, {
      kind: "spawned-by",
      spawnedByParticipantId: spawnerId,
      source: "j5_spawn",
    });
    assert.equal(result.placement.placementParentId, spawnerId);
    const rows = yield* sql<{
      readonly joined: number;
      readonly placements: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM j5_a2a_comm_event
          WHERE kind = 'participant.joined'
            AND json_extract(payload, '$.participant.threadId') = ${childThreadId}) AS joined,
        (SELECT COUNT(*) FROM j5_a2a_participant_placement
          WHERE participant_id = ${result.home.participantId}) AS placements
    `;
    assert.deepStrictEqual(rows, [{ joined: 1, placements: 1 }]);
    const observed = yield* Fiber.join(committedFiber);
    assert.isTrue(Option.isSome(observed));
    if (Option.isSome(observed)) {
      assert.equal(observed.value.kind, "participant.joined");
      if (observed.value.kind === "participant.joined") {
        assert.equal(observed.value.payload.participant.kind, "agent");
        if (observed.value.payload.participant.kind === "agent") {
          assert.equal(observed.value.payload.participant.threadId, childThreadId);
        }
      }
    }
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("rolls home registration back when placement fails afterward", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* SpawnCompositionService;
    const sql = yield* SqlClient.SqlClient;
    const squadronId = SquadronId.make("squadron:spawn-composition:rollback");
    yield* seedSquadronAndSpawner(
      squadronId,
      ThreadId.make("thread:spawn-composition:rollback-spawner"),
    );
    const ledgerService = yield* A2ALedger;
    const committed = yield* ledgerService.subscribeCommitted;
    const committedFiber = yield* committed.pipe(
      Stream.runHead,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.yieldNow;
    const childThreadId = ThreadId.make("thread:spawn-composition:rollback-child");
    const missingSpawnerId = ParticipantId.make("agent:spawn-composition:missing-spawner");

    const exit = yield* Effect.exit(
      service.recordFacts(
        inputFor({
          name: "rollback",
          squadronId,
          threadId: childThreadId,
          spawnedByParticipantId: missingSpawnerId,
        }),
      ),
    );
    assert.isTrue(exit._tag === "Failure");
    const childId = participantIdForThread(childThreadId);
    const rows = yield* sql<{
      readonly events: number;
      readonly memberships: number;
      readonly placements: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM j5_a2a_comm_event
          WHERE kind = 'participant.joined'
            AND json_extract(payload, '$.participant.threadId') = ${childThreadId}) AS events,
        (SELECT COUNT(*) FROM j5_a2a_squadron_membership
          WHERE participant_id = ${childId}) AS memberships,
        (SELECT COUNT(*) FROM j5_a2a_participant_placement
          WHERE participant_id = ${childId}) AS placements
    `;
    assert.deepStrictEqual(rows, [{ events: 0, memberships: 0, placements: 0 }]);
    const sentinelThreadId = ThreadId.make("thread:spawn-composition:rollback-sentinel");
    yield* ledgerService.append({
      commandId: CommCommandId.make("command:spawn-home:rollback-sentinel"),
      squadronId,
      acceptedAt: createdAt,
      event: {
        kind: "participant.joined",
        sender: null,
        receiver: participantIdForThread(sentinelThreadId),
        exchangeId: null,
        correlationId: null,
        payload: {
          participant: {
            kind: "agent",
            id: participantIdForThread(sentinelThreadId),
            threadId: sentinelThreadId,
          },
        },
        createdAt,
      },
    });
    const observed = yield* Fiber.join(committedFiber);
    assert.isTrue(Option.isSome(observed));
    if (Option.isSome(observed)) {
      assert.equal(observed.value.kind, "participant.joined");
      if (observed.value.kind === "participant.joined") {
        assert.equal(observed.value.payload.participant.kind, "agent");
        if (observed.value.payload.participant.kind === "agent") {
          assert.equal(observed.value.payload.participant.threadId, sentinelThreadId);
        }
      }
    }
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("waits for a DeliveryWorker ledger permit before entering the spawn transaction", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const databaseContext = yield* Layer.build(NodeSqliteClient.layerMemory());
      const sql = Context.get(databaseContext, SqlClient.SqlClient);
      const databaseLayer = Layer.succeed(SqlClient.SqlClient, sql);
      yield* runJ5A2AMigrations().pipe(Effect.provide(databaseLayer));

      const ledgerContext = yield* Layer.build(ledgerLayer.pipe(Layer.provide(databaseLayer)));
      const ledgerService = Context.get(ledgerContext, A2ALedger);
      const ledgerWriter = Context.get(ledgerContext, A2ALedgerTransactionWriter);
      const ledgerServices = Layer.mergeAll(
        Layer.succeed(A2ALedger, ledgerService),
        Layer.succeed(A2ALedgerTransactionWriter, ledgerWriter),
      );
      const placementContext = yield* Layer.build(
        placementLayer.pipe(Layer.provide(databaseLayer)),
      );
      const placementWriter = Context.get(placementContext, ParticipantPlacementTransactionWriter);
      const homeTransactionContext = yield* Layer.build(
        homeRegistrationTransactionLayer.pipe(
          Layer.provide(Layer.mergeAll(ledgerServices, databaseLayer)),
        ),
      );
      const homeTransaction = Context.get(homeTransactionContext, A2AHomeRegistrationTransaction);
      const sendContext = yield* Layer.build(
        sendServiceLayer.pipe(
          Layer.provide(Layer.mergeAll(Layer.succeed(A2ALedger, ledgerService), databaseLayer)),
        ),
      );
      const sendService = Context.get(sendContext, A2ASendService);

      const squadronId = SquadronId.make("squadron:spawn-composition:delivery-race");
      const spawnerThreadId = ThreadId.make("thread:spawn-composition:delivery-race-spawner");
      const spawnerId = yield* seedSquadronAndSpawner(squadronId, spawnerThreadId).pipe(
        Effect.provideService(A2ALedger, ledgerService),
      );
      const receiverThreadId = ThreadId.make("thread:spawn-composition:delivery-race-receiver");
      const receiverId = participantIdForThread(receiverThreadId);
      yield* ledgerService.append({
        commandId: CommCommandId.make("command:spawn-composition:delivery-race-receiver"),
        squadronId,
        acceptedAt: createdAt,
        event: {
          kind: "participant.joined",
          sender: null,
          receiver: receiverId,
          exchangeId: null,
          correlationId: null,
          payload: {
            participant: { kind: "agent", id: receiverId, threadId: receiverThreadId },
          },
          createdAt,
        },
      });
      yield* sendService.send({
        commandId: CommCommandId.make("command:spawn-composition:delivery-race-send"),
        senderThreadId: spawnerThreadId,
        to: receiverId,
        message: "Ordering probe",
        acceptedAt: createdAt,
      });

      const deliveryPermitHeld = yield* Deferred.make<void>();
      const releaseDelivery = yield* Deferred.make<void>();
      const blockedLedger = A2ALedger.of({
        ...ledgerService,
        appendEvents: (command) =>
          ledgerWriter.withPermit(
            Deferred.succeed(deliveryPermitHeld, undefined).pipe(
              Effect.andThen(Deferred.await(releaseDelivery)),
              Effect.andThen(
                sql.withTransaction(ledgerWriter.appendEventsInTransaction(command)).pipe(
                  Effect.tap((result) =>
                    result.committed ? ledgerWriter.publishCommitted(result.events) : Effect.void,
                  ),
                  Effect.orDie,
                ),
              ),
            ),
          ),
      });
      const transport: A2ADeliveryTransportShape = {
        deliverAgent: () => Effect.void,
        deliverHuman: () => Effect.void,
      };
      const workerContext = yield* Layer.build(
        deliveryWorkerLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(A2ALedger, blockedLedger),
              Layer.succeed(A2ADeliveryTransport, A2ADeliveryTransport.of(transport)),
              databaseLayer,
            ),
          ),
        ),
      );
      const worker = Context.get(workerContext, A2ADeliveryWorker);

      const spawnOuterBegin = yield* Deferred.make<void>();
      const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
        Deferred.succeed(spawnOuterBegin, undefined).pipe(
          Effect.andThen(sql.withTransaction(effect)),
        );
      const instrumentedSql: SqlClient.SqlClient = new Proxy(sql, {
        get: (target, property, receiver) =>
          property === "withTransaction"
            ? withTransaction
            : Reflect.get(target, property, receiver),
      });
      const spawnContext = yield* Layer.build(
        spawnCompositionLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(A2AHomeRegistrationTransaction, homeTransaction),
              Layer.succeed(A2ALedgerTransactionWriter, ledgerWriter),
              Layer.succeed(ParticipantPlacementTransactionWriter, placementWriter),
              Layer.succeed(SqlClient.SqlClient, instrumentedSql),
            ),
          ),
        ),
      );
      const spawn = Context.get(spawnContext, SpawnCompositionService);

      const deliveryFiber = yield* worker.runOnce.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(deliveryPermitHeld);
      const childThreadId = ThreadId.make("thread:spawn-composition:delivery-race-child");
      const spawnFiber = yield* spawn
        .recordFacts(
          inputFor({
            name: "delivery-race",
            squadronId,
            threadId: childThreadId,
            spawnedByParticipantId: spawnerId,
          }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      assert.isFalse(
        yield* Deferred.isDone(spawnOuterBegin),
        "spawn must wait on appendPermit instead of entering BEGIN",
      );

      yield* Deferred.succeed(releaseDelivery, undefined);
      assert.equal((yield* Fiber.join(deliveryFiber))?.state, "delivered");
      const spawned = yield* Fiber.join(spawnFiber);
      assert.isTrue(yield* Deferred.isDone(spawnOuterBegin));
      assert.equal(spawned.home.participantId, participantIdForThread(childThreadId));
      const rows = yield* sql<{
        readonly delivered: number;
        readonly joined: number;
        readonly placement: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM j5_a2a_comm_event WHERE kind = 'message.delivered') AS delivered,
          (SELECT COUNT(*) FROM j5_a2a_comm_event
            WHERE kind = 'participant.joined'
              AND json_extract(payload, '$.participant.threadId') = ${childThreadId}) AS joined,
          (SELECT COUNT(*) FROM j5_a2a_participant_placement
            WHERE participant_id = ${spawned.home.participantId}) AS placement
      `;
      assert.deepStrictEqual(rows, [{ delivered: 1, joined: 1, placement: 1 }]);
    }),
  ),
);
