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
    assert.deepStrictEqual(j5, [
      { migration_id: 1, name: "EpicCommunicationLedger" },
      { migration_id: 2, name: "SendDeliverReply" },
    ]);
    assert.deepStrictEqual(
      migrationEntries.map(([id]) => id),
      [1, 2],
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
          'j5_a2a_epic_membership',
          'j5_a2a_exchange',
          'j5_a2a_delivery',
          'j5_a2a_human_inbox_data'
        )
      ORDER BY name
    `;
    const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'j5_a2a_comm_command_receipt_epic_seq_idx',
          'j5_a2a_comm_event_received_correlation_idx',
          'j5_a2a_comm_event_command_idx',
          'j5_a2a_exchange_open_pair_idx',
          'j5_a2a_exchange_id_idx',
          'j5_a2a_delivery_drain_idx',
          'j5_a2a_delivery_message_sender_idx',
          'j5_a2a_delivery_one_reply_idx'
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
      { name: "j5_a2a_delivery" },
      { name: "j5_a2a_epic" },
      { name: "j5_a2a_epic_membership" },
      { name: "j5_a2a_exchange" },
      { name: "j5_a2a_human_inbox_data" },
    ]);
    const indexesByName = new Map(indexes.map((index) => [index.name, index.sql]));
    assert.include(
      indexesByName.get("j5_a2a_comm_command_receipt_epic_seq_idx") ?? "",
      "ON j5_a2a_comm_command_receipt(epic_id, result_seq)",
    );
    assert.include(
      indexesByName.get("j5_a2a_comm_event_received_correlation_idx") ?? "",
      "WHERE kind = 'message.received'",
    );
    assert.include(
      indexesByName.get("j5_a2a_comm_event_command_idx") ?? "",
      "ON j5_a2a_comm_event(command_id, epic_id, seq)",
    );
    assert.include(
      indexesByName.get("j5_a2a_exchange_open_pair_idx") ?? "",
      "WHERE status = 'open'",
    );
    assert.include(
      indexesByName.get("j5_a2a_exchange_id_idx") ?? "",
      "ON j5_a2a_exchange(exchange_id)",
    );
    assert.include(
      indexesByName.get("j5_a2a_delivery_drain_idx") ?? "",
      "ON j5_a2a_delivery(status, next_attempt_at, sent_seq)",
    );
    assert.include(
      indexesByName.get("j5_a2a_delivery_message_sender_idx") ?? "",
      "ON j5_a2a_delivery(message_id, sender_id)",
    );
    assert.include(
      indexesByName.get("j5_a2a_delivery_one_reply_idx") ?? "",
      "WHERE exchange_id IS NOT NULL AND exchange_role = 'reply'",
    );
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
