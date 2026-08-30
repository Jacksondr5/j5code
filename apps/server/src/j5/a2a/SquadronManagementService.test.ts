import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import {
  SquadronManagementService,
  layer as squadronManagementServiceLayer,
} from "./SquadronManagementService.ts";
import { layer as squadronProjectReferencesLayer } from "./SquadronProjectReferences.ts";

const projectId = ProjectId.make("project:squadron-management");
const database = NodeSqliteClient.layerMemory();
const ledger = ledgerLayer.pipe(Layer.provide(database));
const references = squadronProjectReferencesLayer.pipe(Layer.provide(database));
const projects = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeed(Option.some({ id: projectId } as never)),
});
const management = squadronManagementServiceLayer.pipe(
  Layer.provide(ledger),
  Layer.provide(references),
  Layer.provide(projects),
  Layer.provide(database),
);
const testLayer = Layer.mergeAll(database, management);

it.effect(
  "creates distinct Squadrons over one explicit project without inferring their identity",
  () =>
    Effect.gen(function* () {
      yield* runJ5A2AMigrations();
      const service = yield* SquadronManagementService;
      const first = yield* service.create({ name: "First", projectId });
      const second = yield* service.create({ name: "Second", projectId });

      assert.notEqual(first.squadron.id, second.squadron.id);
      assert.deepStrictEqual(first.projectIds, [projectId]);
      assert.deepStrictEqual(second.projectIds, [projectId]);
      assert.deepStrictEqual(
        (yield* service.list())
          .map(({ squadron, projectIds }) => ({ name: squadron.name, projectIds }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        [
          { name: "First", projectIds: [projectId] },
          { name: "Second", projectIds: [projectId] },
        ],
      );
    }).pipe(Effect.provide(testLayer)),
);
