import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  migrationManifest as upstreamMigrationManifest,
  runMigrations,
} from "../../persistence/Migrations.ts";
import { J5_A2A_MIGRATIONS_TABLE, migrationEntries, runJ5A2AMigrations } from "./Migrations.ts";

it.effect("tracks J5 A2A migrations independently from upstream migrations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* runJ5A2AMigrations();

    const upstream = yield* sql<{ readonly migration_id: number }>`
      SELECT migration_id
      FROM effect_sql_migrations
      ORDER BY migration_id DESC
      LIMIT 1
    `;
    const j5 = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name
      FROM ${sql(J5_A2A_MIGRATIONS_TABLE)}
      ORDER BY migration_id
    `;

    assert.equal(upstream[0]?.migration_id, upstreamMigrationManifest.at(-1)?.[0]);
    assert.deepStrictEqual(j5, [{ migration_id: 1, name: "EpicCommunicationLedger" }]);
    assert.deepStrictEqual(
      migrationEntries.map(([id]) => id),
      [1],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("creates the exact namespaced ledger schema and receiver correlation constraint", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations();
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'j5_a2a_epic',
          'j5_a2a_comm_event',
          'j5_a2a_comm_command_receipt',
          'j5_a2a_epic_membership'
        )
      ORDER BY name
    `;
    const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'j5_a2a_comm_command_receipt_epic_seq_idx',
          'j5_a2a_comm_event_received_correlation_idx'
        )
      ORDER BY name
    `;
    const unprefixed = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type IN ('table', 'index')
        AND name IN (
          'epic',
          'comm_event',
          'comm_command_receipt',
          'epic_membership',
          'comm_event_received_correlation_idx',
          'comm_command_receipt_epic_seq_idx'
        )
    `;

    assert.deepStrictEqual(tables, [
      { name: "j5_a2a_comm_command_receipt" },
      { name: "j5_a2a_comm_event" },
      { name: "j5_a2a_epic" },
      { name: "j5_a2a_epic_membership" },
    ]);
    assert.equal(indexes[0]?.name, "j5_a2a_comm_command_receipt_epic_seq_idx");
    assert.include(indexes[0]?.sql ?? "", "ON j5_a2a_comm_command_receipt(epic_id, result_seq)");
    assert.equal(indexes[1]?.name, "j5_a2a_comm_event_received_correlation_idx");
    assert.include(indexes[1]?.sql ?? "", "ON j5_a2a_comm_event(epic_id, correlation_id)");
    assert.include(indexes[1]?.sql ?? "", "WHERE kind = 'message.received'");
    assert.deepStrictEqual(unprefixed, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("runs the J5 migration lane during normal SQLite setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'j5_a2a_comm_event'
    `;
    assert.deepStrictEqual(rows, [{ name: "j5_a2a_comm_event" }]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
