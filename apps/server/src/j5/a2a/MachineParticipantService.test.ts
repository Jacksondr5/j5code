import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import {
  MachineParticipantService,
  layer as machineParticipantLayer,
} from "./MachineParticipantService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import { CommCommandId, ParticipantId, SquadronId } from "./contracts.ts";

const timestamp = "2026-09-15T12:00:00.000Z";
const monitoring = SquadronId.make("squadron:monitoring");
const support = SquadronId.make("squadron:support");

const makeTestLayer = () => {
  const database = NodeSqliteClient.layerMemory();
  const ledger = ledgerLayer.pipe(Layer.provide(database));
  const machines = machineParticipantLayer.pipe(Layer.provide(ledger), Layer.provide(database));
  return Layer.mergeAll(database, ledger, machines);
};

const setup = Effect.fn("test.j5.a2a.machine.setup")(function* () {
  yield* runJ5A2AMigrations();
  const ledger = yield* A2ALedger;
  for (const [id, name] of [
    [monitoring, "Monitoring"],
    [support, "L2 Support Rotation"],
  ] as const) {
    yield* ledger.createSquadron({ squadron: { id, name, createdAt: timestamp } });
  }
});

it.effect(
  "registers a machine once per name, replaying the same Squadron and refusing another",
  () =>
    Effect.gen(function* () {
      yield* setup();
      const machines = yield* MachineParticipantService;

      const first = yield* machines.register({
        commandId: CommCommandId.make("command:machine:register:watchdog"),
        squadronId: monitoring,
        name: "watchdog",
        acceptedAt: timestamp,
      });
      assert.isTrue(first.created);
      assert.equal(first.participant.participantId, "machine:watchdog");
      assert.equal(first.participant.squadronName, "Monitoring");

      const again = yield* machines.register({
        commandId: CommCommandId.make("command:machine:register:watchdog:again"),
        squadronId: monitoring,
        name: "watchdog",
        acceptedAt: timestamp,
      });
      assert.isFalse(again.created);
      assert.deepStrictEqual(again.participant, first.participant);

      const elsewhere = yield* Effect.flip(
        machines.register({
          commandId: CommCommandId.make("command:machine:register:watchdog:support"),
          squadronId: support,
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
        (yield* machines.resolve(ParticipantId.make("machine:watchdog"))).squadronId,
        monitoring,
      );
    }).pipe(Effect.provide(makeTestLayer())),
);

it.effect("refuses invalid names, unknown Squadrons, and unknown machines by name", () =>
  Effect.gen(function* () {
    yield* setup();
    const machines = yield* MachineParticipantService;

    const invalid = yield* Effect.flip(
      machines.register({
        commandId: CommCommandId.make("command:machine:register:bad"),
        squadronId: monitoring,
        name: "Watch Dog",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(invalid._tag, "MachineParticipantInvalidNameError");

    const missingSquadron = yield* Effect.flip(
      machines.register({
        commandId: CommCommandId.make("command:machine:register:nowhere"),
        squadronId: SquadronId.make("squadron:nowhere"),
        name: "watchdog",
        acceptedAt: timestamp,
      }),
    );
    assert.equal(missingSquadron._tag, "SquadronNotFoundError");

    const unknown = yield* Effect.flip(machines.resolve(ParticipantId.make("machine:ghost")));
    assert.equal(unknown._tag, "MachineParticipantNotFoundError");
  }).pipe(Effect.provide(makeTestLayer())),
);
