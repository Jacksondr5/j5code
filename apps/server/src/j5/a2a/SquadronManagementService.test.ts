import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ProjectService from "../../project/ProjectService.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { ClientReadsService, layer as clientReadsLayer } from "./ClientReadsService.ts";
import { layer as humanInboxLayer } from "./HumanInboxService.ts";
import { A2ALedger, layer as ledgerLayer } from "./LedgerService.ts";
import { runJ5A2AMigrations } from "./Migrations.ts";
import {
  SquadronManagementService,
  layer as squadronManagementServiceLayer,
} from "./SquadronManagementService.ts";
import { layer as squadronProjectReferencesLayer } from "./SquadronProjectReferences.ts";
import { CommCommandId, ParticipantId, SquadronId } from "./contracts.ts";

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
const inbox = humanInboxLayer.pipe(Layer.provide(ledger), Layer.provide(database));
const clientReads = clientReadsLayer.pipe(Layer.provide(inbox), Layer.provide(database));
const testLayer = Layer.mergeAll(database, ledger, management, clientReads);

/** Read from the live schema so a new table that references Squadrons is checked without edits. */
const squadronReferencingColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'j5%'
  `;
  const columns: Array<{ readonly table: string; readonly column: string }> = [];
  for (const { name } of tables) {
    const keys = yield* sql.unsafe<{ readonly table: string; readonly from: string }>(
      `PRAGMA foreign_key_list(${name})`,
    );
    for (const key of keys) {
      if (key.table === "j5_a2a_squadron") columns.push({ table: name, column: key.from });
    }
  }
  return columns;
});

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

const timestamp = "2026-08-29T21:00:00.000Z";

const agentFor = (squadronId: SquadronId, index: number) => ({
  kind: "agent" as const,
  id: ParticipantId.make(`agent:${squadronId}:${index}`),
  threadId: ThreadId.make(`thread:${squadronId}:${index}`),
});

const appendMembership = (
  squadronId: SquadronId,
  index: number,
  kind: "participant.joined" | "participant.archived",
) =>
  Effect.gen(function* () {
    const ledger = yield* A2ALedger;
    const participant = agentFor(squadronId, index);
    yield* ledger.append({
      commandId: CommCommandId.make(`command:${squadronId}:${index}:${kind}`),
      squadronId,
      acceptedAt: timestamp,
      event: {
        kind,
        sender: null,
        receiver: participant.id,
        exchangeId: null,
        correlationId: null,
        payload: { participant },
        createdAt: timestamp,
      },
    });
  });

const joinAgent = (squadronId: SquadronId, index: number) =>
  appendMembership(squadronId, index, "participant.joined");

const countWhere = (table: string, squadronId: SquadronId, column = "squadron_id") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ readonly count: number }>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
      [squadronId],
    );
    return Number(rows[0]?.count ?? 0);
  });

it.effect("renames a Squadron with a trimmed name and rejects a blank one", () =>
  Effect.gen(function* () {
    yield* runJ5A2AMigrations();
    const service = yield* SquadronManagementService;
    const created = yield* service.create({ name: "Before", projectId });

    const renamed = yield* service.rename({ squadronId: created.squadron.id, name: "  After  " });
    assert.equal(renamed.squadron.id, created.squadron.id);
    assert.equal(renamed.squadron.name, "After");
    assert.deepStrictEqual(renamed.projectIds, [projectId]);
    assert.deepStrictEqual(
      (yield* service.list()).map(({ squadron }) => squadron.name),
      ["After"],
    );

    const blank = yield* Effect.flip(
      service.rename({ squadronId: created.squadron.id, name: "   " }),
    );
    assert.equal(blank._tag, "SquadronNameRequiredError");
    const missing = yield* Effect.flip(
      service.rename({ squadronId: SquadronId.make("squadron:missing"), name: "Ghost" }),
    );
    assert.equal(missing._tag, "SquadronNotFoundError");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("deletes an empty Squadron together with its project references", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* runJ5A2AMigrations();
    const service = yield* SquadronManagementService;
    const doomed = yield* service.create({ name: "Doomed", projectId });
    const kept = yield* service.create({ name: "Kept", projectId });

    yield* service.delete(doomed.squadron.id);

    assert.deepStrictEqual(
      (yield* service.list()).map(({ squadron }) => squadron.id),
      [kept.squadron.id],
    );
    const references = yield* sql<{ readonly squadron_id: string }>`
      SELECT squadron_id FROM j5_a2a_squadron_project_reference
    `;
    assert.deepStrictEqual(references, [{ squadron_id: kept.squadron.id }]);
    const missing = yield* Effect.flip(service.delete(doomed.squadron.id));
    assert.equal(missing._tag, "SquadronNotFoundError");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("deletes a Squadron whose only member is archived and purges its history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* runMigrations();
    yield* runJ5A2AMigrations();
    const service = yield* SquadronManagementService;
    const reads = yield* ClientReadsService;
    const retired = yield* service.create({ name: "Retired", projectId });
    const kept = yield* service.create({ name: "Kept", projectId });
    yield* joinAgent(retired.squadron.id, 1);
    yield* appendMembership(retired.squadron.id, 1, "participant.archived");
    yield* joinAgent(kept.squadron.id, 1);
    const retiredThread = agentFor(retired.squadron.id, 1).threadId;
    const keptThread = agentFor(kept.squadron.id, 1).threadId;
    yield* sql`
      INSERT INTO j5_a2a_placement_event (
        seq, command_id, request_fingerprint, squadron_id, participant_id, kind, actor,
        provenance_kind, created_at
      ) VALUES (
        1, 'command:placement', 'fingerprint', ${retired.squadron.id},
        ${agentFor(retired.squadron.id, 1).id}, 'participant.placement_created', 'platform',
        'unknown', ${timestamp}
      )
    `;
    for (const table of ["j5_a2a_comm_event", "j5_a2a_comm_command_receipt"]) {
      assert.equal(yield* countWhere(table, retired.squadron.id), 2, table);
    }
    assert.equal(yield* countWhere("j5_a2a_placement_event", retired.squadron.id), 1);
    assert.deepStrictEqual(
      (yield* reads.threadHomes([retiredThread])).map((entry) => entry.home.kind),
      ["known"],
    );

    yield* service.delete(retired.squadron.id);

    assert.deepStrictEqual(
      (yield* service.list()).map(({ squadron }) => squadron.id),
      [kept.squadron.id],
    );
    for (const { table, column } of yield* squadronReferencingColumns) {
      assert.equal(yield* countWhere(table, retired.squadron.id, column), 0, table);
    }
    assert.deepStrictEqual(yield* reads.threadHomes([retiredThread, keptThread]), [
      { threadId: retiredThread, home: { kind: "unknown" } },
      {
        threadId: keptThread,
        home: { kind: "known", squadron: { id: kept.squadron.id, name: "Kept" } },
      },
    ]);
    assert.equal(yield* countWhere("j5_a2a_comm_event", kept.squadron.id), 1);
    assert.equal(yield* countWhere("j5_a2a_squadron_membership", kept.squadron.id), 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses to delete a Squadron that still has an active agent or an unarchived Crew", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* runJ5A2AMigrations();
    const service = yield* SquadronManagementService;

    const staffed = yield* service.create({ name: "Staffed", projectId });
    yield* joinAgent(staffed.squadron.id, 1);
    yield* joinAgent(staffed.squadron.id, 2);
    const memberBlocked = yield* Effect.flip(service.delete(staffed.squadron.id));
    assert.equal(memberBlocked._tag, "SquadronDeleteBlockedError");
    assert.equal(
      memberBlocked.message,
      'Squadron "Staffed" cannot be deleted while it still has 2 active agents.',
    );

    const crewed = yield* service.create({ name: "Crewed", projectId });
    yield* sql`
      INSERT INTO j5_agent_crew_instance (
        id, squadron_id, captain_participant_id, captain_thread_id, display_name, brief, version, created_at
      ) VALUES (
        'crew:test', ${crewed.squadron.id}, 'agent:captain', 'thread:captain', 'Crew', 'brief', 1, ${timestamp}
      )
    `;
    const crewBlocked = yield* Effect.flip(service.delete(crewed.squadron.id));
    assert.equal(crewBlocked._tag, "SquadronDeleteBlockedError");
    assert.equal(
      crewBlocked.message,
      'Squadron "Crewed" cannot be deleted while it still has 1 unarchived Crew.',
    );

    assert.deepStrictEqual((yield* service.list()).map(({ squadron }) => squadron.name).sort(), [
      "Crewed",
      "Staffed",
    ]);
    assert.equal(yield* countWhere("j5_a2a_comm_event", staffed.squadron.id), 2);
  }).pipe(Effect.provide(testLayer)),
);
