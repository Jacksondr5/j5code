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
      { migration_id: 3, name: "SquadronRename" },
      { migration_id: 4, name: "SilenceNoticeChannel" },
      { migration_id: 5, name: "ImmutableThreadHome" },
    ]);
    assert.deepStrictEqual(
      migrationEntries.map(([id]) => id),
      [1, 2, 3, 4, 5],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("creates the exact namespaced ledger schema and receiver correlation constraint", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 3 });
    const deliveriesBeforeA3 = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM j5_a2a_delivery
    `;
    assert.deepStrictEqual(deliveriesBeforeA3, [{ count: 0 }]);
    yield* runJ5A2AMigrations();
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'j5_a2a_squadron',
          'j5_a2a_comm_event',
          'j5_a2a_comm_command_receipt',
          'j5_a2a_squadron_membership',
          'j5_a2a_exchange',
          'j5_a2a_delivery',
          'j5_a2a_human_inbox_data',
          'j5_a2a_silence_detector_cursor'
        )
      ORDER BY name
    `;
    const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'j5_a2a_comm_command_receipt_squadron_seq_idx',
          'j5_a2a_comm_event_received_correlation_idx',
          'j5_a2a_comm_event_command_idx',
          'j5_a2a_exchange_open_pair_idx',
          'j5_a2a_exchange_id_idx',
          'j5_a2a_delivery_drain_idx',
          'j5_a2a_delivery_message_sender_idx',
          'j5_a2a_delivery_one_reply_idx',
          'j5_a2a_comm_event_agent_home_thread_idx'
        )
      ORDER BY name
    `;
    const unprefixed = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type IN ('table', 'index')
        AND name IN (
          'squadron',
          'comm_event',
          'comm_command_receipt',
          'squadron_membership',
          'comm_event_received_correlation_idx',
          'comm_command_receipt_squadron_seq_idx'
        )
    `;
    const deliveryColumns = yield* sql<{
      readonly dflt_value: string | null;
      readonly name: string;
      readonly notnull: number;
    }>`
      PRAGMA table_info(j5_a2a_delivery)
    `;

    assert.deepStrictEqual(tables, [
      { name: "j5_a2a_comm_command_receipt" },
      { name: "j5_a2a_comm_event" },
      { name: "j5_a2a_delivery" },
      { name: "j5_a2a_exchange" },
      { name: "j5_a2a_human_inbox_data" },
      { name: "j5_a2a_silence_detector_cursor" },
      { name: "j5_a2a_squadron" },
      { name: "j5_a2a_squadron_membership" },
    ]);
    const indexesByName = new Map(indexes.map((index) => [index.name, index.sql]));
    assert.include(
      indexesByName.get("j5_a2a_comm_command_receipt_squadron_seq_idx") ?? "",
      "ON j5_a2a_comm_command_receipt(squadron_id, result_seq)",
    );
    assert.include(
      indexesByName.get("j5_a2a_comm_event_received_correlation_idx") ?? "",
      "WHERE kind = 'message.received'",
    );
    assert.include(
      indexesByName.get("j5_a2a_comm_event_command_idx") ?? "",
      "ON j5_a2a_comm_event(command_id, squadron_id, seq)",
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
    assert.include(
      indexesByName.get("j5_a2a_comm_event_agent_home_thread_idx") ?? "",
      "json_extract(payload, '$.participant.threadId')",
    );
    assert.include(
      indexesByName.get("j5_a2a_comm_event_agent_home_thread_idx") ?? "",
      "WHERE kind = 'participant.joined'",
    );
    const envelopeChannel = deliveryColumns.find((column) => column.name === "envelope_channel");
    assert.equal(envelopeChannel?.notnull, 1);
    assert.isNull(envelopeChannel?.dflt_value);
    const cursor = yield* sql<{ readonly after_sequence: number | null }>`
      SELECT after_sequence FROM j5_a2a_silence_detector_cursor WHERE singleton = 1
    `;
    assert.deepStrictEqual(cursor, [{ after_sequence: null }]);
    assert.deepStrictEqual(unprefixed, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("renames existing Squadron data without changing ledger semantics", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 2 });
    yield* sql`
      INSERT INTO j5_a2a_epic (id, name, created_at)
      VALUES ('legacy-home', 'Legacy home', '2026-08-18T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO j5_a2a_comm_event (
        seq,
        epic_id,
        kind,
        sender,
        receiver,
        exchange_id,
        correlation_id,
        payload,
        created_at,
        command_id
      ) VALUES (
        1,
        'legacy-home',
        'message.sent',
        'agent:sender',
        'agent:receiver',
        NULL,
        'correlation:sent',
        json_object(
          'messageId', 'message:sent',
          'text', 'Preserve me',
          'originEpicId', 'legacy-home',
          'receiverEpicId', 'legacy-home',
          'exchangeRole', 'none',
          'envelopeChannel', 'peer'
        ),
        '2026-08-18T00:00:00.000Z',
        'command:sent'
      )
    `;
    yield* sql`
      INSERT INTO j5_a2a_comm_event (
        seq,
        epic_id,
        kind,
        sender,
        receiver,
        exchange_id,
        correlation_id,
        payload,
        created_at,
        command_id
      ) VALUES (
        2,
        'legacy-home',
        'message.received',
        'agent:sender',
        'agent:receiver',
        NULL,
        'correlation:received',
        json_object(
          'originEpicId', 'legacy-home',
          'message', json_object('text', 'Preserve me')
        ),
        '2026-08-18T00:00:01.000Z',
        'command:received'
      )
    `;

    yield* runJ5A2AMigrations();

    const events = yield* sql<{
      readonly squadron_id: string;
      readonly kind: string;
      readonly payload: string;
    }>`
      SELECT squadron_id, kind, payload
      FROM j5_a2a_comm_event
      ORDER BY seq
    `;
    assert.deepStrictEqual(
      events.map((event) => ({
        squadron_id: event.squadron_id,
        kind: event.kind,
        payload: JSON.parse(event.payload),
      })),
      [
        {
          squadron_id: "legacy-home",
          kind: "message.sent",
          payload: {
            messageId: "message:sent",
            text: "Preserve me",
            exchangeRole: "none",
            envelopeChannel: "peer",
            originSquadronId: "legacy-home",
            receiverSquadronId: "legacy-home",
          },
        },
        {
          squadron_id: "legacy-home",
          kind: "message.received",
          payload: {
            message: { text: "Preserve me" },
            originSquadronId: "legacy-home",
          },
        },
      ],
    );
    const legacySchema = yield* sql<{ readonly name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type IN ('table', 'index')
        AND name IN (
          'j5_a2a_epic',
          'j5_a2a_epic_membership',
          'j5_a2a_comm_command_receipt_epic_seq_idx'
        )
    `;
    assert.deepStrictEqual(legacySchema, []);
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
