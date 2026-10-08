import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import {
  MachineParticipantService,
  layer as machineParticipantLayer,
} from "./MachineParticipantService.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { CommCommandId, ParticipantId, LedgerProjectId } from "./contracts.ts";

const timestamp = "2026-09-15T12:00:00.000Z";
const monitoring = LedgerProjectId.make("project:monitoring");
const support = LedgerProjectId.make("project:support");

const makeTestLayer = () => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const machines = machineParticipantLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  return Layer.mergeAll(database, ledger, machines);
};

const setup = Effect.fn("test.j5.a2a.machine.setup")(function* () {
  yield* runMigrations();
  yield* runJ5A2AMigrations();
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* A2ALedger;
  for (const [id, name] of [
    [monitoring, "Monitoring"],
    [support, "L2 Support Rotation"],
  ] as const) {
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      ) VALUES (${id}, ${name}, ${`/tmp/${id}`}, '[]', ${timestamp}, ${timestamp}, NULL)
    `;
    yield* ledger.ensureProject({ projectId: id, createdAt: timestamp });
  }
});

it.effect(
  "registers a machine once per name, replaying the same project and refusing another",
  () =>
    Effect.gen(function* () {
      yield* setup();
      const machines = yield* MachineParticipantService;

      const first = yield* machines.register({
        commandId: CommCommandId.make("command:machine:register:watchdog"),
        projectId: monitoring,
        name: "watchdog",
        acceptedAt: timestamp,
      });
      assert.isTrue(first.created);
      assert.equal(first.participant.participantId, "machine:watchdog");
      assert.equal(first.participant.projectTitle, "Monitoring");

      const again = yield* machines.register({
        commandId: CommCommandId.make("command:machine:register:watchdog:again"),
        projectId: monitoring,
        name: "watchdog",
        acceptedAt: timestamp,
      });
      assert.isFalse(again.created);
      assert.deepStrictEqual(again.participant, first.participant);

      const elsewhere = yield* Effect.flip(
        machines.register({
          commandId: CommCommandId.make("command:machine:register:watchdog:support"),
          projectId: support,
          name: "watchdog",
          acceptedAt: timestamp,
        }),
      );
      assert.equal(elsewhere._tag, "MachineParticipantNameTakenError");

      assert.deepStrictEqual(
        (yield* machines.list()).map((record) => record.participantId),
        ["machine:watchdog"],
      );
      assert.equal(
        (yield* machines.resolve(ParticipantId.make("machine:watchdog"))).projectId,
        monitoring,
      );
    }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("refuses invalid names, unknown projects, and unknown machines by name", () =>
  Effect.gen(function* () {
    yield* setup();
    const machines = yield* MachineParticipantService;

    const invalid = yield* Effect.flip(
      machines.register({
        commandId: CommCommandId.make("command:machine:register:bad"),
        projectId: monitoring,
        name: "Watch Dog",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(invalid._tag, "MachineParticipantInvalidNameError");

    const missingProject = yield* Effect.flip(
      machines.register({
        commandId: CommCommandId.make("command:machine:register:nowhere"),
        projectId: LedgerProjectId.make("project:nowhere"),
        name: "watchdog",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(missingProject._tag, "MachineParticipantProjectNotFoundError");

    const unknown = yield* Effect.flip(machines.resolve(ParticipantId.make("machine:ghost")));
    assert.equal(unknown._tag, "MachineParticipantNotFoundError");
  }).pipe(Effect.provide(makeTestLayer())),
);
