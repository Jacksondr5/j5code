import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import {
  A2AHomeRegistrar,
  participantIdForThread,
  layer as homeRegistrarLayer,
} from "./HomeRegistrar.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { CommCommandId, SquadronId } from "./contracts.ts";

const createdAt = "2026-08-19T15:30:00.000Z";
const database = NodeSqliteClient.layerMemory();
const ledger = ledgerLayer.pipe(Layer.provide(database));
const registrar = homeRegistrarLayer.pipe(Layer.provide(ledger), Layer.provide(database));
const testLayer = Layer.mergeAll(database, ledger, registrar);

const createSquadron = Effect.fn("test.j5.a2a.createSquadron")(function* (squadronId: SquadronId) {
  const ledgerService = yield* A2ALedger;
  yield* ledgerService.createSquadron({
    squadron: { id: squadronId, name: `Home ${squadronId}`, createdAt },
  });
});

const countJoined = Effect.fn("test.j5.a2a.countJoined")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM j5_a2a_comm_event
    WHERE kind = 'participant.joined'
      AND json_extract(payload, '$.participant.threadId') = ${threadId}
  `;
  return rows[0]?.count ?? 0;
});

it.effect("registers one immutable home with the authoritative creation inputs", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2AHomeRegistrar;
    const sql = yield* SqlClient.SqlClient;
    const squadronId = SquadronId.make("squadron:registrar:initial");
    const threadId = ThreadId.make("thread:registrar:initial");
    const commandId = CommCommandId.make("command:registrar:initial");
    yield* createSquadron(squadronId);

    const home = yield* service.registerAtCreation({
      squadronId,
      threadId,
      createdAt,
      commandId,
    });

    assert.deepStrictEqual(home, {
      squadronId,
      participantId: participantIdForThread(threadId),
    });
    const events = yield* sql<{
      readonly command_id: string;
      readonly created_at: string;
      readonly receiver: string;
      readonly squadron_id: string;
    }>`
      SELECT command_id, created_at, receiver, squadron_id
      FROM j5_a2a_comm_event
      WHERE kind = 'participant.joined'
    `;
    assert.deepStrictEqual(events, [
      {
        command_id: commandId,
        created_at: createdAt,
        receiver: home.participantId,
        squadron_id: squadronId,
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("replays the exact creation key without appending a second join", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2AHomeRegistrar;
    const squadronId = SquadronId.make("squadron:registrar:replay");
    const threadId = ThreadId.make("thread:registrar:replay");
    const input = {
      squadronId,
      threadId,
      createdAt,
      commandId: CommCommandId.make("command:registrar:replay"),
    };
    yield* createSquadron(squadronId);

    const initial = yield* service.registerAtCreation(input);
    const replay = yield* service.registerAtCreation(input);

    assert.deepStrictEqual(replay, initial);
    assert.equal(yield* countJoined(threadId), 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects changed creation inputs when the command id replays", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2AHomeRegistrar;
    const squadronId = SquadronId.make("squadron:registrar:command-conflict");
    const threadId = ThreadId.make("thread:registrar:command-conflict");
    const commandId = CommCommandId.make("command:registrar:command-conflict");
    yield* createSquadron(squadronId);
    yield* service.registerAtCreation({ squadronId, threadId, createdAt, commandId });

    const error = yield* Effect.flip(
      service.registerAtCreation({
        squadronId,
        threadId,
        createdAt: "2026-08-19T15:30:01.000Z",
        commandId,
      }),
    );

    assert.equal(error._tag, "A2AHomeCommandConflictError");
    assert.equal(yield* countJoined(threadId), 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects a conflicting home without appending into the requested squadron", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2AHomeRegistrar;
    const existingSquadronId = SquadronId.make("squadron:registrar:existing");
    const requestedSquadronId = SquadronId.make("squadron:registrar:requested");
    const threadId = ThreadId.make("thread:registrar:conflict");
    yield* createSquadron(existingSquadronId);
    yield* createSquadron(requestedSquadronId);
    yield* service.registerAtCreation({
      squadronId: existingSquadronId,
      threadId,
      createdAt,
      commandId: CommCommandId.make("command:registrar:existing"),
    });

    const error = yield* Effect.flip(
      service.registerAtCreation({
        squadronId: requestedSquadronId,
        threadId,
        createdAt,
        commandId: CommCommandId.make("command:registrar:requested"),
      }),
    );

    assert.equal(error._tag, "A2AHomeConflictError");
    if (error._tag === "A2AHomeConflictError") {
      assert.equal(error.existingSquadronId, existingSquadronId);
      assert.equal(error.requestedSquadronId, requestedSquadronId);
    }
    assert.equal(yield* countJoined(threadId), 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("distinguishes no home and keeps the historical home after active membership ends", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2AHomeRegistrar;
    const ledgerService = yield* A2ALedger;
    const squadronId = SquadronId.make("squadron:registrar:lookup");
    const threadId = ThreadId.make("thread:registrar:lookup");
    yield* createSquadron(squadronId);

    const missing = yield* Effect.flip(service.getHomeForThread(threadId));
    assert.equal(missing._tag, "A2AHomeNotFoundError");
    const home = yield* service.registerAtCreation({
      squadronId,
      threadId,
      createdAt,
      commandId: CommCommandId.make("command:registrar:lookup"),
    });
    yield* ledgerService.append({
      commandId: CommCommandId.make("command:registrar:lookup:left"),
      squadronId,
      acceptedAt: createdAt,
      event: {
        kind: "participant.left",
        sender: home.participantId,
        receiver: null,
        exchangeId: null,
        correlationId: null,
        payload: {
          participant: { kind: "agent", id: home.participantId, threadId },
        },
        createdAt,
      },
    });

    assert.deepStrictEqual(yield* service.getHomeForThread(threadId), home);
    assert.deepStrictEqual(yield* ledgerService.listMembership(squadronId), []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("atomically allows only one of two concurrent first-home registrations", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2AHomeRegistrar;
    const firstSquadronId = SquadronId.make("squadron:registrar:race:first");
    const secondSquadronId = SquadronId.make("squadron:registrar:race:second");
    const threadId = ThreadId.make("thread:registrar:race");
    yield* createSquadron(firstSquadronId);
    yield* createSquadron(secondSquadronId);

    const outcomes = yield* Effect.all(
      [firstSquadronId, secondSquadronId].map((squadronId, index) =>
        Effect.result(
          service.registerAtCreation({
            squadronId,
            threadId,
            createdAt,
            commandId: CommCommandId.make(`command:registrar:race:${index}`),
          }),
        ),
      ),
      { concurrency: "unbounded" },
    );
    const successes = outcomes.filter((outcome) => outcome._tag === "Success");
    const failures = outcomes.filter((outcome) => outcome._tag === "Failure");

    assert.lengthOf(successes, 1);
    assert.lengthOf(failures, 1);
    assert.equal(failures[0]?.failure._tag, "A2AHomeConflictError");
    assert.equal(yield* countJoined(threadId), 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("requires the caller-selected squadron to exist before registration", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* A2AHomeRegistrar;
    const threadId = ThreadId.make("thread:registrar:missing-squadron");

    const error = yield* Effect.flip(
      service.registerAtCreation({
        squadronId: SquadronId.make("squadron:registrar:missing"),
        threadId,
        createdAt,
        commandId: CommCommandId.make("command:registrar:missing-squadron"),
      }),
    );

    assert.equal(error._tag, "SquadronNotFoundError");
    assert.equal(yield* countJoined(threadId), 0);
  }).pipe(Effect.provide(testLayer)),
);
