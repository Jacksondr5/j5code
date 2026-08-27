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
import Migration0005 from "./migrations/005_ImmutableThreadHome.ts";

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
      { migration_id: 6, name: "HumanNode" },
    ]);
    assert.deepStrictEqual(
      migrationEntries.map(([id]) => id),
      [1, 2, 3, 4, 5, 6],
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
          'j5_a2a_human_inbox',
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
      { name: "j5_a2a_human_inbox" },
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
      "CREATE UNIQUE INDEX j5_a2a_comm_event_agent_home_thread_idx",
    );
    assert.include(
      indexesByName.get("j5_a2a_comm_event_agent_home_thread_idx") ?? "",
      "WHERE kind = 'participant.joined'",
    );
    assert.include(
      indexesByName.get("j5_a2a_comm_event_agent_home_thread_idx") ?? "",
      "json_extract(payload, '$.participant.kind') = 'agent'",
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

it.effect("reports conflicting thread ids before creating the immutable-home index", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runJ5A2AMigrations({ toMigrationInclusive: 4 });
    yield* sql`
      INSERT INTO j5_a2a_squadron (id, name, created_at) VALUES
        ('squadron:migration-conflict:first', 'First conflict source', '2026-08-19T00:00:00.000Z'),
        ('squadron:migration-conflict:second', 'Second conflict source', '2026-08-19T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO j5_a2a_comm_event (
        seq,
        squadron_id,
        kind,
        sender,
        receiver,
        exchange_id,
        correlation_id,
        payload,
        created_at,
        command_id
      ) VALUES
        (
          1,
          'squadron:migration-conflict:first',
          'participant.joined',
          NULL,
          'agent:migration-conflict:a:first',
          NULL,
          NULL,
          json_object(
            'participant',
            json_object(
              'kind', 'agent',
              'id', 'agent:migration-conflict:a:first',
              'threadId', 'thread:migration-conflict:a'
            )
          ),
          '2026-08-19T00:00:00.000Z',
          'command:migration-conflict:a:first'
        ),
        (
          2,
          'squadron:migration-conflict:first',
          'participant.joined',
          NULL,
          'agent:migration-conflict:b:first',
          NULL,
          NULL,
          json_object(
            'participant',
            json_object(
              'kind', 'agent',
              'id', 'agent:migration-conflict:b:first',
              'threadId', 'thread:migration-conflict:b'
            )
          ),
          '2026-08-19T00:00:00.000Z',
          'command:migration-conflict:b:first'
        ),
        (
          1,
          'squadron:migration-conflict:second',
          'participant.joined',
          NULL,
          'agent:migration-conflict:a:second',
          NULL,
          NULL,
          json_object(
            'participant',
            json_object(
              'kind', 'agent',
              'id', 'agent:migration-conflict:a:second',
              'threadId', 'thread:migration-conflict:a'
            )
          ),
          '2026-08-19T00:00:00.000Z',
          'command:migration-conflict:a:second'
        ),
        (
          2,
          'squadron:migration-conflict:second',
          'participant.joined',
          NULL,
          'agent:migration-conflict:b:second',
          NULL,
          NULL,
          json_object(
            'participant',
            json_object(
              'kind', 'agent',
              'id', 'agent:migration-conflict:b:second',
              'threadId', 'thread:migration-conflict:b'
            )
          ),
          '2026-08-19T00:00:00.000Z',
          'command:migration-conflict:b:second'
        )
    `;

    const error = yield* Effect.flip(Migration0005);

    assert.include(String(error), "thread:migration-conflict:a (2 joins)");
    assert.include(String(error), "thread:migration-conflict:b (2 joins)");
    assert.include(String(error), "Repair duplicate participant.joined history");
    const indexes = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'index' AND name = 'j5_a2a_comm_event_agent_home_thread_idx'
    `;
    assert.deepStrictEqual(indexes, [{ count: 0 }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "migrates the singleton human and preserves old delivered obligations as person history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runJ5A2AMigrations({ toMigrationInclusive: 5 });
      yield* sql`
      INSERT INTO j5_a2a_squadron (id, name, created_at)
      VALUES ('squadron:legacy-human', 'Legacy human', '2026-08-20T00:00:00.000Z')
    `;
      yield* sql`
      INSERT INTO j5_a2a_squadron_membership (
        squadron_id,
        participant_id,
        participant_kind,
        thread_id,
        joined_seq,
        updated_seq,
        payload
      ) VALUES (
        'squadron:legacy-human',
        'human:global',
        'human',
        NULL,
        1,
        1,
        json_object('kind', 'human')
      )
    `;
      yield* sql`
      INSERT INTO j5_a2a_comm_event (
        seq,
        squadron_id,
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
        'squadron:legacy-human',
        'participant.joined',
        NULL,
        'human:global',
        NULL,
        NULL,
        json_object('participant', json_object('kind', 'human')),
        '2026-08-20T00:00:00.000Z',
        'command:legacy-human:joined'
      )
    `;
      yield* sql`
      INSERT INTO j5_a2a_exchange (
        squadron_id,
        exchange_id,
        sender_id,
        receiver_id,
        status,
        intent,
        urgency,
        opened_seq,
        closed_seq,
        created_at,
        updated_at
      ) VALUES
        (
          'squadron:legacy-human',
          'exchange:legacy-human:open',
          'agent:legacy-asker',
          'human:global',
          'open',
          'Old unanswered request',
          'blocking',
          2,
          NULL,
          '2026-08-20T00:01:00.000Z',
          '2026-08-20T00:01:00.000Z'
        ),
        (
          'squadron:legacy-human',
          'exchange:legacy-human:closed',
          'agent:legacy-asker',
          'human:global',
          'closed',
          'Old answered request',
          'fyi',
          3,
          4,
          '2026-08-20T00:02:00.000Z',
          '2026-08-20T00:03:00.000Z'
        )
    `;
      yield* sql`
      INSERT INTO j5_a2a_delivery (
        squadron_id,
        message_id,
        command_id,
        sent_seq,
        sender_id,
        receiver_id,
        receiver_squadron_id,
        exchange_id,
        exchange_role,
        correlation_id,
        message_text,
        status,
        attempts,
        last_error,
        next_attempt_at,
        delivered_seq,
        created_at,
        updated_at,
        envelope_channel
      ) VALUES
        (
          'squadron:legacy-human',
          'message:legacy-human:open',
          'command:legacy-human:open',
          2,
          'agent:legacy-asker',
          'human:global',
          'squadron:legacy-human',
          'exchange:legacy-human:open',
          'ask',
          'correlation:legacy-human:open',
          'Please preserve this old unanswered request.',
          'delivered',
          1,
          NULL,
          NULL,
          5,
          '2026-08-20T00:01:00.000Z',
          '2026-08-20T00:01:01.000Z',
          'peer'
        ),
        (
          'squadron:legacy-human',
          'message:legacy-human:closed',
          'command:legacy-human:closed',
          3,
          'agent:legacy-asker',
          'human:global',
          'squadron:legacy-human',
          'exchange:legacy-human:closed',
          'ask',
          'correlation:legacy-human:closed',
          'Preserve this answered request too.',
          'delivered',
          1,
          NULL,
          NULL,
          6,
          '2026-08-20T00:02:00.000Z',
          '2026-08-20T00:02:01.000Z',
          'peer'
        )
    `;
      yield* sql`
      INSERT INTO j5_a2a_human_inbox_data (
        origin_squadron_id,
        message_id,
        exchange_id,
        sender_id,
        payload,
        created_at
      ) VALUES
        (
          'squadron:legacy-human',
          'message:legacy-human:open',
          'exchange:legacy-human:open',
          'agent:legacy-asker',
          'Please preserve this old unanswered request.',
          '2026-08-20T00:01:01.000Z'
        ),
        (
          'squadron:legacy-human',
          'message:legacy-human:closed',
          'exchange:legacy-human:closed',
          'agent:legacy-asker',
          'Preserve this answered request too.',
          '2026-08-20T00:02:01.000Z'
        )
    `;

      yield* runJ5A2AMigrations();

      const memberships = yield* sql<{
        readonly participant_id: string;
        readonly payload: string;
      }>`
      SELECT participant_id, payload
      FROM j5_a2a_squadron_membership
      WHERE squadron_id = 'squadron:legacy-human'
    `;
      assert.deepStrictEqual(
        memberships.map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
        [
          {
            participant_id: "human:legacy-person",
            payload: { kind: "human", id: "human:legacy-person" },
          },
        ],
      );
      const events = yield* sql<{ readonly receiver: string; readonly payload: string }>`
      SELECT receiver, payload
      FROM j5_a2a_comm_event
      WHERE squadron_id = 'squadron:legacy-human'
    `;
      assert.deepStrictEqual(
        events.map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
        [
          {
            receiver: "human:legacy-person",
            payload: { participant: { kind: "human", id: "human:legacy-person" } },
          },
        ],
      );
      const durable = yield* sql<{
        readonly exchange_id: string;
        readonly person_id: string;
        readonly receiver_id: string;
        readonly status: string;
        readonly terminal_disposition: string | null;
      }>`
      SELECT
        inbox.exchange_id,
        inbox.person_id,
        raw.receiver_id,
        inbox.status,
        inbox.terminal_disposition
      FROM j5_a2a_human_inbox AS inbox
      JOIN j5_a2a_human_inbox_data AS raw
        ON raw.origin_squadron_id = inbox.squadron_id
       AND raw.message_id = inbox.latest_message_id
      ORDER BY inbox.exchange_id
    `;
      assert.deepStrictEqual(durable, [
        {
          exchange_id: "exchange:legacy-human:closed",
          person_id: "human:legacy-person",
          receiver_id: "human:legacy-person",
          status: "answered",
          terminal_disposition: "answered",
        },
        {
          exchange_id: "exchange:legacy-human:open",
          person_id: "human:legacy-person",
          receiver_id: "human:legacy-person",
          status: "open",
          terminal_disposition: null,
        },
      ]);
      const remainingGlobalReferences = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM (
        SELECT participant_id AS value FROM j5_a2a_squadron_membership
        UNION ALL SELECT sender FROM j5_a2a_comm_event
        UNION ALL SELECT receiver FROM j5_a2a_comm_event
        UNION ALL SELECT sender_id FROM j5_a2a_exchange
        UNION ALL SELECT receiver_id FROM j5_a2a_exchange
        UNION ALL SELECT sender_id FROM j5_a2a_delivery
        UNION ALL SELECT receiver_id FROM j5_a2a_delivery
        UNION ALL SELECT sender_id FROM j5_a2a_human_inbox_data
        UNION ALL SELECT receiver_id FROM j5_a2a_human_inbox_data
        UNION ALL SELECT person_id FROM j5_a2a_human_inbox
      )
      WHERE value = 'human:global'
    `;
      assert.deepStrictEqual(remainingGlobalReferences, [{ count: 0 }]);
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
