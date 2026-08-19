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
  MessageSentPayload,
  Squadron,
  SquadronId,
  LedgerMessageId,
  ParticipantId,
  type AppendCommEventCommand,
  type CommEvent,
  type LedgerCursor,
} from "./contracts.ts";

const timestamp = "2026-08-16T12:00:00.000Z";
const isSquadron = Schema.is(Squadron);
const decodeMessageSentPayload = Schema.decodeUnknownSync(MessageSentPayload);
const isLedgerGapError = Schema.is(LedgerGapError);
const isA2AStorageError = Schema.is(A2AStorageError);

const memoryLedgerLayer = () =>
  ledgerLayer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

const fileLedgerLayer = (filename: string) =>
  ledgerLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename })));

const messageEvent = (index: number): CommEvent => ({
  kind: "silence.notice",
  sender: ParticipantId.make("agent:sender"),
  receiver: ParticipantId.make("agent:receiver"),
  exchangeId: null,
  correlationId: null,
  payload: { index },
  createdAt: timestamp,
});

it.effect("routes single-event append through command ids and A2 projections", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const squadronId = SquadronId.make("squadron:single-append-projection");
    const commandId = CommCommandId.make("command:single-append-projection");
    const messageId = LedgerMessageId.make("message:single-append-projection");
    yield* ledger.createSquadron({
      squadron: { id: squadronId, name: "Single append projection", createdAt: timestamp },
    });
    yield* ledger.append({
      commandId,
      squadronId,
      acceptedAt: timestamp,
      event: {
        kind: "message.sent",
        sender: ParticipantId.make("agent:single:sender"),
        receiver: ParticipantId.make("agent:single:receiver"),
        exchangeId: null,
        correlationId: CorrelationId.make("correlation:single-append-projection"),
        payload: {
          messageId,
          text: "Single append remains deliverable.",
          originSquadronId: squadronId,
          receiverSquadronId: squadronId,
          exchangeRole: "none",
          envelopeChannel: "peer",
        },
        createdAt: timestamp,
      },
    });

    const rows = yield* sql<{
      readonly command_id: string;
      readonly message_id: string;
      readonly status: string;
    }>`
      SELECT command_id, message_id, status
      FROM j5_a2a_delivery
      WHERE message_id = ${messageId}
    `;
    assert.deepStrictEqual(rows, [
      { command_id: commandId, message_id: messageId, status: "pending" },
    ]);
  }).pipe(Effect.provide(memoryLedgerLayer())),
);

const appendCommand = (
  squadronId: SquadronId,
  index: number,
  event: CommEvent = messageEvent(index),
): AppendCommEventCommand => ({
  commandId: CommCommandId.make(`command:${squadronId}:${index}`),
  squadronId,
  acceptedAt: timestamp,
  event,
});

it.effect("creates, lists, and reads minimal squadrons", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const first = {
      id: SquadronId.make("squadron:first"),
      name: "First squadron",
      createdAt: timestamp,
    };
    const second = {
      id: SquadronId.make("squadron:second"),
      name: "Second squadron",
      createdAt: "2026-08-16T12:00:01.000Z",
    };

    yield* ledger.createSquadron({ squadron: second });
    yield* ledger.createSquadron({ squadron: first });

    assert.deepStrictEqual(yield* ledger.readSquadron(first.id), first);
    assert.deepStrictEqual(yield* ledger.listSquadrons(), [first, second]);
  }).pipe(Effect.provide(memoryLedgerLayer())),
);

it("rejects a whitespace-only squadron name during contract validation", () => {
  assert.isFalse(
    isSquadron({
      id: SquadronId.make("squadron:blank-name"),
      name: "   ",
      createdAt: timestamp,
    }),
  );
});

it("requires an explicit envelope channel on every sent-message payload", () => {
  assert.throws(() =>
    decodeMessageSentPayload({
      messageId: LedgerMessageId.make("message:missing-envelope-channel"),
      text: "An implicit peer channel is not valid.",
      originSquadronId: SquadronId.make("squadron:origin"),
      receiverSquadronId: SquadronId.make("squadron:receiver"),
      exchangeRole: "none",
    }),
  );
});

it.effect("replays an append command from its durable receipt without adding a row", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const squadronId = SquadronId.make("squadron:idempotency");
    yield* ledger.createSquadron({
      squadron: { id: squadronId, name: "Idempotency", createdAt: timestamp },
    });
    const command = appendCommand(squadronId, 1);

    const first = yield* ledger.append(command);
    const replay = yield* ledger.append(command);
    const page = yield* ledger.readEvents({
      squadronId,
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

it.effect("publishes committed events in their per-squadron sequence order", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const squadronId = SquadronId.make("squadron:published-order");
    yield* ledger.createSquadron({
      squadron: { id: squadronId, name: "Published order", createdAt: timestamp },
    });
    const committed = yield* ledger.subscribeCommitted;
    const observedFiber = yield* committed.pipe(
      Stream.take(3),
      Stream.runCollect,
      Effect.forkChild({ startImmediately: true }),
    );

    yield* Effect.all(
      [1, 2, 3].map((index) => ledger.append(appendCommand(squadronId, index))),
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
      const squadronId = SquadronId.make("squadron:property");
      yield* ledger.createSquadron({
        squadron: { id: squadronId, name: "Property", createdAt: timestamp },
      });
      for (let index = 1; index <= eventCount; index += 1) {
        yield* ledger.append(appendCommand(squadronId, index));
      }

      const sequences: Array<number> = [];
      let cursor: LedgerCursor = { afterSeq: 0 };
      let complete = false;
      while (!complete) {
        const page = yield* ledger.readEvents({ squadronId, cursor, limit: pageSize });
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
    const squadronId = SquadronId.make("squadron:gap-negative-control");
    yield* ledger.createSquadron({
      squadron: { id: squadronId, name: "Gap negative control", createdAt: timestamp },
    });
    for (let index = 1; index <= 3; index += 1) {
      yield* ledger.append(appendCommand(squadronId, index));
    }

    yield* sql`DELETE FROM j5_a2a_comm_event WHERE squadron_id = ${squadronId} AND seq = 2`;
    const error = yield* Effect.flip(
      ledger.readEvents({ squadronId, cursor: { afterSeq: 0 }, limit: 10 }),
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
    const squadronId = SquadronId.make("squadron:membership");
    yield* ledger.createSquadron({
      squadron: { id: squadronId, name: "Membership", createdAt: timestamp },
    });
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
      yield* ledger.append(appendCommand(squadronId, index + 1, event));
    }

    const expected = [
      {
        squadronId,
        participant: secondAgent,
        joinedSeq: 3,
        updatedSeq: 4,
      },
      {
        squadronId,
        participant: { kind: "human" as const },
        joinedSeq: 2,
        updatedSeq: 2,
      },
    ];
    const before = yield* ledger.listMembership(squadronId);
    assert.deepStrictEqual(before, expected);

    yield* sql`DELETE FROM j5_a2a_squadron_membership WHERE squadron_id = ${squadronId}`;
    const corrupted = yield* ledger.listMembership(squadronId);
    assert.deepStrictEqual(corrupted, []);
    assert.notEqual(corrupted.length, expected.length);

    const rebuilt = yield* ledger.rebuildMembership(squadronId);
    assert.deepStrictEqual(rebuilt, expected);
    const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
    assert.equal(yield* encode(rebuilt), yield* encode(before));
  }).pipe(Effect.provide(memoryLedgerLayer())),
);

it.effect("persists squadrons, events, and receipts across a database restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "j5-a2a-ledger-" });
      const filename = path.join(directory, "state.sqlite");
      const squadronId = SquadronId.make("squadron:restart");
      const command = appendCommand(squadronId, 1);
      const firstProcess = Effect.gen(function* () {
        yield* runJ5A2AMigrations();
        const ledger = yield* A2ALedger;
        yield* ledger.createSquadron({
          squadron: { id: squadronId, name: "Restart", createdAt: timestamp },
        });
        const result = yield* ledger.append(command);
        assert.isTrue(result.committed);
      }).pipe(Effect.provide(fileLedgerLayer(filename)));
      const secondProcess = Effect.gen(function* () {
        yield* runJ5A2AMigrations();
        const ledger = yield* A2ALedger;
        assert.equal((yield* ledger.readSquadron(squadronId)).name, "Restart");
        const replay = yield* ledger.append(command);
        assert.isFalse(replay.committed);
        const page = yield* ledger.readEvents({
          squadronId,
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

it.effect("enforces one message.received correlation per receiver squadron", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const squadronId = SquadronId.make("squadron:receiver");
    const correlationId = CorrelationId.make("correlation:shared");
    yield* ledger.createSquadron({
      squadron: { id: squadronId, name: "Receiver", createdAt: timestamp },
    });
    const receivedEvent: CommEvent = {
      kind: "message.received",
      sender: ParticipantId.make("agent:external"),
      receiver: ParticipantId.make("agent:local"),
      exchangeId: null,
      correlationId,
      payload: {
        originSquadronId: SquadronId.make("squadron:origin"),
        message: "hello",
      },
      createdAt: timestamp,
    };
    yield* ledger.append(appendCommand(squadronId, 1, receivedEvent));
    const failedCommand = CommCommandId.make(`command:${squadronId}:2`);
    const error = yield* Effect.flip(
      ledger.appendEvents({
        commandId: failedCommand,
        squadronId,
        acceptedAt: timestamp,
        events: [receivedEvent],
      }),
    );
    assert.isTrue(isA2AStorageError(error));
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM j5_a2a_comm_event
      WHERE squadron_id = ${squadronId} AND kind = 'message.received'
    `;
    assert.equal(rows[0]?.count, 1);

    const receipts = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM j5_a2a_comm_command_receipt
      WHERE command_id = ${failedCommand}
    `;
    assert.equal(receipts[0]?.count, 0, "the failed event insert rolls back its receipt");

    const retried = yield* ledger.appendEvents({
      commandId: failedCommand,
      squadronId,
      acceptedAt: timestamp,
      events: [
        {
          ...receivedEvent,
          correlationId: CorrelationId.make("correlation:retry-after-rollback"),
        },
      ],
    });
    assert.isTrue(retried.committed, "the rolled-back command id remains reusable");
  }).pipe(Effect.provide(memoryLedgerLayer())),
);

it.effect("rejects delivery transitions without a projected message row", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledger = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;
    const squadronId = SquadronId.make("squadron:missing-delivery-projection");
    yield* ledger.createSquadron({
      squadron: { id: squadronId, name: "Missing delivery projection", createdAt: timestamp },
    });
    const transitions: ReadonlyArray<{ readonly name: string; readonly event: CommEvent }> = [
      {
        name: "delivered",
        event: {
          kind: "message.delivered",
          sender: ParticipantId.make("agent:delivery:sender"),
          receiver: ParticipantId.make("agent:delivery:receiver"),
          exchangeId: null,
          correlationId: CorrelationId.make("correlation:missing-delivered"),
          payload: {
            messageId: LedgerMessageId.make("message:missing-delivered"),
            attempt: 1,
            channel: "agent",
          },
          createdAt: timestamp,
        },
      },
      {
        name: "delivery-failed",
        event: {
          kind: "message.delivery_failed",
          sender: ParticipantId.make("agent:delivery:sender"),
          receiver: ParticipantId.make("agent:delivery:receiver"),
          exchangeId: null,
          correlationId: CorrelationId.make("correlation:missing-delivery-failed"),
          payload: {
            messageId: LedgerMessageId.make("message:missing-delivery-failed"),
            attempt: 1,
            error: "forced missing projection",
            nextAttemptAt: timestamp,
            alarmed: false,
          },
          createdAt: timestamp,
        },
      },
    ];

    for (const [index, transition] of transitions.entries()) {
      const commandId = CommCommandId.make(`command:missing-delivery:${transition.name}`);
      const error = yield* Effect.flip(
        ledger.appendEvents({
          commandId,
          squadronId,
          acceptedAt: timestamp,
          events: [transition.event],
        }),
      );
      assert.isTrue(isA2AStorageError(error));

      const retried = yield* ledger.appendEvents({
        commandId,
        squadronId,
        acceptedAt: timestamp,
        events: [messageEvent(index + 100)],
      });
      assert.isTrue(retried.committed, "the failed projection rolls back its command receipt");
    }

    const transitionRows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM j5_a2a_comm_event
      WHERE squadron_id = ${squadronId}
        AND kind IN ('message.delivered', 'message.delivery_failed')
    `;
    assert.equal(transitionRows[0]?.count, 0);
  }).pipe(Effect.provide(memoryLedgerLayer())),
);
