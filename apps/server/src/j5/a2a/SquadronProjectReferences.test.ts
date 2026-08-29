import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import {
  SquadronProjectReferences,
  layer as squadronProjectReferencesLayer,
} from "./SquadronProjectReferences.ts";
import { SquadronId } from "./contracts.ts";

const createdAt = "2026-08-29T16:00:00.000Z";
const database = NodeSqliteClient.layerMemory();
const ledger = ledgerLayer.pipe(Layer.provide(database));
const references = squadronProjectReferencesLayer.pipe(Layer.provide(database));
const testLayer = Layer.mergeAll(database, ledger, references);

const createSquadron = Effect.fn("test.j5.a2a.createSquadronForProjectReference")(function* (
  squadronId: SquadronId,
) {
  const service = yield* A2ALedger;
  yield* service.createSquadron({
    squadron: { id: squadronId, name: `Squadron ${squadronId}`, createdAt },
  });
});

it.effect("keeps an ordered list-ready project reference list per Squadron", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* SquadronProjectReferences;
    const squadronId = SquadronId.make("squadron:project-references:ordered");
    const firstProjectId = ProjectId.make("project:project-references:first");
    const secondProjectId = ProjectId.make("project:project-references:second");
    yield* createSquadron(squadronId);

    const references = yield* service.replaceForSquadron({
      squadronId,
      projectIds: [secondProjectId, firstProjectId],
      createdAt,
    });

    assert.deepStrictEqual(references, [
      { squadronId, projectId: secondProjectId, ordinal: 0, createdAt },
      { squadronId, projectId: firstProjectId, ordinal: 1, createdAt },
    ]);
    assert.deepStrictEqual(yield* service.listForSquadron(squadronId), references);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "allows two Squadrons to reference the same project without making it their identity",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const service = yield* SquadronProjectReferences;
      const firstSquadronId = SquadronId.make("squadron:project-references:first");
      const secondSquadronId = SquadronId.make("squadron:project-references:second");
      const projectId = ProjectId.make("project:project-references:shared");
      yield* createSquadron(firstSquadronId);
      yield* createSquadron(secondSquadronId);

      yield* service.replaceForSquadron({
        squadronId: firstSquadronId,
        projectIds: [projectId],
        createdAt,
      });
      yield* service.replaceForSquadron({
        squadronId: secondSquadronId,
        projectIds: [projectId],
        createdAt,
      });

      assert.deepStrictEqual(yield* service.listForSquadron(firstSquadronId), [
        { squadronId: firstSquadronId, projectId, ordinal: 0, createdAt },
      ]);
      assert.deepStrictEqual(yield* service.listForSquadron(secondSquadronId), [
        { squadronId: secondSquadronId, projectId, ordinal: 0, createdAt },
      ]);
    }).pipe(Effect.provide(testLayer)),
);
