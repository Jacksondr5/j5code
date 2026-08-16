import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FastCheck } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import {
  A2ALedger,
  A2AStorageError,
  LedgerGapError,
  layer as ledgerLayer,
} from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import {
  CommCommandId,
  CorrelationId,
  EpicId,
  ParticipantId,
  type AppendCommEventCommand,
  type CommEvent,
  type LedgerCursor,
} from "./contracts.ts";

const timestamp = "2026-08-16T12:00:00.000Z";
const isLedgerGapError = Schema.is(LedgerGapError);
const isA2AStorageError = Schema.is(A2AStorageError);

const memoryLedgerLayer = () =>
  ledgerLayer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

const fileLedgerLayer = (filename: string) =>
  ledgerLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename })));

const messageEvent = (index: number): CommEvent => ({
  kind: "message.sent",
  sender: ParticipantId.make("agent:sender"),
  receiver: ParticipantId.make("agent:receiver"),
  exchangeId: null,
  correlationId: null,
  payload: { index },
  createdAt: timestamp,
});

const appendCommand = (
  epicId: EpicId,
  index: number,
  event: CommEvent = messageEvent(index),
): AppendCommEventCommand => ({
  commandId: CommCommandId.make(`command:${epicId}:${index}`),
  epicId,
  acceptedAt: timestamp,
  event,
});

it.effect("creates, lists, and reads minimal epics", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const first = {
      id: EpicId.make("epic:first"),
      name: "First epic",
      createdAt: timestamp,
    };
    const second = {
      id: EpicId.make("epic:second"),
      name: "Second epic",
      createdAt: "2026-08-16T12:00:01.000Z",
    };

    yield* ledger.createEpic({ epic: second });
    yield* ledger.createEpic({ epic: first });

    assert.deepStrictEqual(yield* ledger.readEpic(first.id), first);
    assert.deepStrictEqual(yield* ledger.listEpics(), [first, second]);
  }).pipe(Effect.provide(memoryLedgerLayer())),
);

it.effect("replays an append command from its durable receipt without adding a row", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const epicId = EpicId.make("epic:idempotency");
    yield* ledger.createEpic({ epic: { id: epicId, name: "Idempotency", createdAt: timestamp } });
    const command = appendCommand(epicId, 1);

    const first = yield* ledger.append(command);
    const replay = yield* ledger.append(command);
    const page = yield* ledger.readEvents({
      epicId,
      cursor: { afterSeq: 0 },
      limit: 10,
    });

    assert.isTrue(first.committed);
    assert.isFalse(replay.committed);
    assert.deepStrictEqual(replay.receipt, first.receipt);
    assert.deepStrictEqual(replay.event, first.event);
    assert.lengthOf(page.events, 1);
  }).pipe(Effect.provide(memoryLedgerLayer())),
);

it.effect("publishes committed events in their per-epic sequence order", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const epicId = EpicId.make("epic:published-order");
    yield* ledger.createEpic({
      epic: { id: epicId, name: "Published order", createdAt: timestamp },
    });
    const committed = yield* ledger.subscribeCommitted;
    const observedFiber = yield* committed.pipe(
      Stream.take(3),
      Stream.runCollect,
      Effect.forkChild({ startImmediately: true }),
    );

    yield* Effect.all(
      [1, 2, 3].map((index) => ledger.append(appendCommand(epicId, index))),
      { concurrency: "unbounded" },
    );
    const observed = yield* Fiber.join(observedFiber);

    assert.deepStrictEqual(
      Array.from(observed, (event) => event.seq),
      [1, 2, 3],
    );
  }).pipe(Effect.provide(memoryLedgerLayer())),
);

it.effect.prop(
  "reads generated ledgers strictly once and gap-free across cursor pages",
  {
    eventCount: FastCheck.integer({ min: 1, max: 32 }),
    pageSize: FastCheck.integer({ min: 1, max: 8 }),
  },
  ({ eventCount, pageSize }) =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const ledger = yield* A2ALedger;
      const epicId = EpicId.make("epic:property");
      yield* ledger.createEpic({ epic: { id: epicId, name: "Property", createdAt: timestamp } });
      for (let index = 1; index <= eventCount; index += 1) {
        yield* ledger.append(appendCommand(epicId, index));
      }

      const sequences: Array<number> = [];
      let cursor: LedgerCursor = { afterSeq: 0 };
      let complete = false;
      while (!complete) {
        const page = yield* ledger.readEvents({ epicId, cursor, limit: pageSize });
        sequences.push(...page.events.map((event) => event.seq));
        cursor = page.nextCursor;
        complete = page.complete;
      }

      assert.deepStrictEqual(
        sequences,
        Array.from({ length: eventCount }, (_, index) => index + 1),
      );
      assert.equal(new Set(sequences).size, eventCount);
    }).pipe(Effect.provide(memoryLedgerLayer())),
  { fastCheck: { numRuns: 24 } },
);

it.effect("negative control: a deleted ledger row fails the gap-free read", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const epicId = EpicId.make("epic:gap-negative-control");
    yield* ledger.createEpic({
      epic: { id: epicId, name: "Gap negative control", createdAt: timestamp },
    });
    for (let index = 1; index <= 3; index += 1) {
      yield* ledger.append(appendCommand(epicId, index));
    }

    yield* sql`DELETE FROM comm_event WHERE epic_id = ${epicId} AND seq = 2`;
    const error = yield* Effect.flip(
      ledger.readEvents({ epicId, cursor: { afterSeq: 0 }, limit: 10 }),
    );

    assert.isTrue(isLedgerGapError(error));
    if (isLedgerGapError(error)) {
      assert.equal(error.expectedSeq, 2);
      assert.equal(error.actualSeq, 3);
    }
  }).pipe(Effect.provide(memoryLedgerLayer())),
);

it.effect("rebuilds the active membership projection byte-equivalently from the ledger", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const epicId = EpicId.make("epic:membership");
    yield* ledger.createEpic({ epic: { id: epicId, name: "Membership", createdAt: timestamp } });
    const firstAgent = {
      kind: "agent" as const,
      id: ParticipantId.make("agent:first"),
      threadId: ThreadId.make("thread:first"),
    };
    const secondAgent = {
      kind: "agent" as const,
      id: ParticipantId.make("agent:second"),
      threadId: ThreadId.make("thread:second"),
    };
    const membershipEvents: ReadonlyArray<CommEvent> = [
      {
        kind: "participant.joined",
        sender: null,
        receiver: firstAgent.id,
        exchangeId: null,
        correlationId: null,
        payload: { participant: firstAgent },
        createdAt: timestamp,
      },
      {
        kind: "participant.joined",
        sender: null,
        receiver: null,
        exchangeId: null,
        correlationId: null,
        payload: { participant: { kind: "human" } },
        createdAt: timestamp,
      },
      {
        kind: "participant.joined",
        sender: null,
        receiver: secondAgent.id,
        exchangeId: null,
        correlationId: null,
        payload: { participant: secondAgent },
        createdAt: timestamp,
      },
      {
        kind: "participant.left",
        sender: firstAgent.id,
        receiver: null,
        exchangeId: null,
        correlationId: null,
        payload: { participant: firstAgent },
        createdAt: timestamp,
      },
    ];
    for (const [index, event] of membershipEvents.entries()) {
      yield* ledger.append(appendCommand(epicId, index + 1, event));
    }

    const expected = [
      {
        epicId,
        participant: secondAgent,
        joinedSeq: 3,
        updatedSeq: 3,
      },
      {
        epicId,
        participant: { kind: "human" as const },
        joinedSeq: 2,
        updatedSeq: 2,
      },
    ];
    const before = yield* ledger.listMembership(epicId);
    assert.deepStrictEqual(before, expected);

    yield* sql`DELETE FROM epic_membership WHERE epic_id = ${epicId}`;
    const corrupted = yield* ledger.listMembership(epicId);
    assert.deepStrictEqual(corrupted, []);
    assert.notEqual(corrupted.length, expected.length);

    const rebuilt = yield* ledger.rebuildMembership(epicId);
    assert.deepStrictEqual(rebuilt, expected);
    const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
    assert.equal(yield* encode(rebuilt), yield* encode(before));
  }).pipe(Effect.provide(memoryLedgerLayer())),
);

it.effect("persists epics, events, and receipts across a database restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "j5-a2a-ledger-" });
      const filename = path.join(directory, "state.sqlite");
      const epicId = EpicId.make("epic:restart");
      const command = appendCommand(epicId, 1);
      const firstProcess = Effect.gen(function* () {
        yield* runJ5A2AMigrations();
        const ledger = yield* A2ALedger;
        yield* ledger.createEpic({ epic: { id: epicId, name: "Restart", createdAt: timestamp } });
        const result = yield* ledger.append(command);
        assert.isTrue(result.committed);
      }).pipe(Effect.provide(fileLedgerLayer(filename)));
      const secondProcess = Effect.gen(function* () {
        yield* runJ5A2AMigrations();
        const ledger = yield* A2ALedger;
        assert.equal((yield* ledger.readEpic(epicId)).name, "Restart");
        const replay = yield* ledger.append(command);
        assert.isFalse(replay.committed);
        const page = yield* ledger.readEvents({
          epicId,
          cursor: { afterSeq: 0 },
          limit: 10,
        });
        assert.deepStrictEqual(
          page.events.map((event) => event.seq),
          [1],
        );
      }).pipe(Effect.provide(fileLedgerLayer(filename)));
      yield* firstProcess;
      yield* secondProcess;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("enforces one message.received correlation per receiver epic", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const epicId = EpicId.make("epic:receiver");
    const correlationId = CorrelationId.make("correlation:shared");
    yield* ledger.createEpic({ epic: { id: epicId, name: "Receiver", createdAt: timestamp } });
    const receivedEvent: CommEvent = {
      kind: "message.received",
      sender: ParticipantId.make("agent:external"),
      receiver: ParticipantId.make("agent:local"),
      exchangeId: null,
      correlationId,
      payload: {
        originEpicId: EpicId.make("epic:origin"),
        message: "hello",
      },
      createdAt: timestamp,
    };
    yield* ledger.append(appendCommand(epicId, 1, receivedEvent));
    const error = yield* Effect.flip(ledger.append(appendCommand(epicId, 2, receivedEvent)));
    assert.isTrue(isA2AStorageError(error));
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM comm_event
      WHERE epic_id = ${epicId} AND kind = 'message.received'
    `;
    assert.equal(rows[0]?.count, 1);
  }).pipe(Effect.provide(memoryLedgerLayer())),
);
