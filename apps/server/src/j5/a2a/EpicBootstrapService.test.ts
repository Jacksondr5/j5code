import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { A2AEpicBootstrap, layer as bootstrapLayer } from "./EpicBootstrapService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { CommCommandId, EpicId, ParticipantId } from "./contracts.ts";

const timestamp = "2026-08-16T12:00:00.000Z";
const threadId = ThreadId.make("thread:bootstrap");

const database = NodeSqliteClient.layerMemory();
const ledger = ledgerLayer.pipe(Layer.provide(database));
const bootstrap = bootstrapLayer.pipe(Layer.provide(ledger));
const testLayer = Layer.mergeAll(database, ledger, bootstrap);

it.effect("creates, reuses, and explicitly changes the caller's selected epic", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2AEpicBootstrap;
    const ledgerService = yield* A2ALedger;
    const sql = yield* SqlClient.SqlClient;

    const created = yield* service.joinEpic({ senderThreadId: threadId, acceptedAt: timestamp });
    assert.equal(created.state, "created");
    const rejoined = yield* service.joinEpic({ senderThreadId: threadId, acceptedAt: timestamp });
    assert.equal(rejoined.state, "selected");
    assert.equal(rejoined.epicId, created.epicId);
    assert.equal(rejoined.participantId, created.participantId);

    const firstJoinEvents = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM j5_a2a_comm_event
      WHERE epic_id = ${created.epicId}
        AND kind = 'participant.joined'
        AND receiver = ${created.participantId}
    `;
    assert.equal(firstJoinEvents[0]?.count, 1, "idempotent rejoin does not append ledger junk");

    const selectedEpicId = EpicId.make("epic:bootstrap:selected");
    const selected = yield* service.joinEpic({
      senderThreadId: threadId,
      epicId: selectedEpicId,
      acceptedAt: timestamp,
    });
    assert.equal(selected.state, "created");
    assert.deepStrictEqual(selected.previousEpicIds, [created.epicId]);
    assert.deepStrictEqual(yield* ledgerService.listMembership(created.epicId), []);
    assert.equal(
      (yield* ledgerService.listMembership(selectedEpicId))[0]?.participant.kind,
      "agent",
    );

    const selectedAgain = yield* service.joinEpic({
      senderThreadId: threadId,
      epicId: selectedEpicId,
      acceptedAt: timestamp,
    });
    assert.equal(selectedAgain.state, "selected");
    const eventCounts = yield* sql<{ readonly kind: string; readonly count: number }>`
      SELECT kind, COUNT(*) AS count
      FROM j5_a2a_comm_event
      WHERE receiver = ${created.participantId}
        AND kind IN ('participant.joined', 'participant.left')
      GROUP BY kind
      ORDER BY kind
    `;
    assert.deepStrictEqual(eventCounts, [
      { kind: "participant.joined", count: 2 },
      { kind: "participant.left", count: 1 },
    ]);

    const selectedBack = yield* service.joinEpic({
      senderThreadId: threadId,
      epicId: created.epicId,
      acceptedAt: timestamp,
    });
    assert.equal(selectedBack.state, "joined");
    assert.deepStrictEqual(selectedBack.previousEpicIds, [selectedEpicId]);
    assert.equal((yield* ledgerService.listMembership(created.epicId)).length, 1);
    assert.deepStrictEqual(yield* ledgerService.listMembership(selectedEpicId), []);

    const finalEventCounts = yield* sql<{ readonly kind: string; readonly count: number }>`
      SELECT kind, COUNT(*) AS count
      FROM j5_a2a_comm_event
      WHERE receiver = ${created.participantId}
        AND kind IN ('participant.joined', 'participant.left')
      GROUP BY kind
      ORDER BY kind
    `;
    assert.deepStrictEqual(finalEventCounts, [
      { kind: "participant.joined", count: 3 },
      { kind: "participant.left", count: 2 },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("derives one command id for concurrent attempts to join the same epic", () =>
  Effect.gen(function* () {
    const commandIds = yield* Ref.make<ReadonlyArray<CommCommandId>>([]);
    const mockedLedger = Layer.mock(A2ALedger)({
      listEpics: () => Effect.succeed([]),
      listMembership: () => Effect.succeed([]),
      createEpic: ({ epic }) => Effect.succeed(epic),
      appendEvents: (command) =>
        Ref.update(commandIds, (ids) => [...ids, command.commandId]).pipe(
          Effect.as({
            receipt: {
              commandId: command.commandId,
              epicId: command.epicId,
              commandType: "comm.append" as const,
              acceptedAt: command.acceptedAt,
              resultSeq: command.events.length,
            },
            events: command.events.map((event, index) => ({
              ...event,
              epicId: command.epicId,
              seq: index + 1,
            })),
            committed: true,
          }),
        ),
    });
    const serviceLayer = bootstrapLayer.pipe(Layer.provide(mockedLedger));

    const results = yield* Effect.all(
      [
        A2AEpicBootstrap.pipe(
          Effect.flatMap((service) =>
            service.joinEpic({ senderThreadId: threadId, acceptedAt: timestamp }),
          ),
        ),
        A2AEpicBootstrap.pipe(
          Effect.flatMap((service) =>
            service.joinEpic({ senderThreadId: threadId, acceptedAt: timestamp }),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.provide(serviceLayer));

    assert.equal(results[0].epicId, results[1].epicId);
    assert.equal(results[0].participantId, results[1].participantId);
    const captured = yield* Ref.get(commandIds);
    assert.lengthOf(captured, 2);
    assert.equal(captured[0], captured[1]);
  }),
);

it.effect("requires explicit selection when legacy membership is ambiguous", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const ledgerService = yield* A2ALedger;
    const participant = {
      kind: "agent" as const,
      id: ParticipantId.make("agent:bootstrap:ambiguous"),
      threadId,
    };
    for (const [index, epicId] of [
      EpicId.make("epic:bootstrap:ambiguous:a"),
      EpicId.make("epic:bootstrap:ambiguous:b"),
    ].entries()) {
      yield* ledgerService.createEpic({
        epic: { id: epicId, name: `Ambiguous ${index}`, createdAt: timestamp },
      });
      yield* ledgerService.appendEvents({
        commandId: CommCommandId.make(`command:bootstrap:ambiguous:${index}`),
        epicId,
        acceptedAt: timestamp,
        events: [
          {
            kind: "participant.joined",
            sender: null,
            receiver: participant.id,
            exchangeId: null,
            correlationId: null,
            payload: { participant },
            createdAt: timestamp,
          },
        ],
      });
    }

    const error = yield* Effect.flip(
      (yield* A2AEpicBootstrap).joinEpic({ senderThreadId: threadId, acceptedAt: timestamp }),
    );
    assert.equal(error._tag, "A2AEpicSelectionRequiredError");
    assert.include(error.message, "Retry join_epic with one explicit epic_id");
  }).pipe(Effect.provide(testLayer)),
);
