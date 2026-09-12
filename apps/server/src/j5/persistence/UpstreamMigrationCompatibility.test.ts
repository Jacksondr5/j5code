import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  migrationEntries,
  migrationManifest,
  runMigrations,
} from "../../persistence/Migrations.ts";
import { migrationEntries as j5MigrationEntries, runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { runJ5CompatibleUpstreamMigrations } from "./UpstreamMigrationCompatibility.ts";

const runLegacy = Migrator.make({});
const installLegacy = Effect.fn("installLegacy")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* runLegacy({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        migrationEntries
          .filter(([id]) => id <= 40 || (id >= 48 && id <= 56))
          .map(([id, name, migration]) => [`${id >= 48 ? id - 7 : id}_${name}`, migration]),
      ),
    ),
  });
  yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-08-15 12:00:00'`;
});

const readHistory = Effect.fn("readHistory")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly migration_id: number;
    readonly name: string;
    readonly created_at: string;
  }>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
});

const readSchema = Effect.fn("readSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT name, type, sql FROM sqlite_master ORDER BY name`;
});

const assertRefused = Effect.fn("assertRefused")(function* (message: RegExp) {
  const before = yield* readSchema();
  const history = yield* readHistory();
  const exit = yield* Effect.exit(runJ5CompatibleUpstreamMigrations());
  assert.isTrue(Exit.isFailure(exit));
  if (Exit.isFailure(exit)) assert.match(Cause.pretty(exit.cause), message);
  assert.deepStrictEqual(yield* readHistory(), history);
  assert.deepStrictEqual(yield* readSchema(), before);
});

const modelSelection = '{"instanceId":"codex","model":"gpt-5.6-sol"}';
const seedProjectDefaults = Effect.fn("seedProjectDefaults")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const id of ["automatic", "explicit"]) {
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at)
      VALUES (${id}, ${id}, '/test/project', ${modelSelection}, '[]', '2026-08-15', '2026-08-15')`;
    yield* sql`INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
      VALUES (${`event:${id}`}, 'project', ${id}, 1, 'project.created', '2026-08-15', 'user',
        json_object('defaultModelSelection', json(${modelSelection})), '{}')`;
  }
  yield* sql`INSERT INTO orchestration_events
    (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
    VALUES ('event:configured', 'project', 'explicit', 2, 'project.meta-updated', '2026-08-15', 'user',
      json_object('defaultModelSelection', json(${modelSelection})), '{}')`;
});

it.effect("installs a fresh database through the unchanged upstream runner", () =>
  Effect.gen(function* () {
    const executed = yield* runJ5CompatibleUpstreamMigrations();
    assert.deepStrictEqual(executed, migrationManifest);
    assert.deepStrictEqual(
      (yield* readHistory()).map(({ migration_id, name }) => [migration_id, name] as const),
      migrationManifest,
    );
    assert.deepStrictEqual(yield* runJ5CompatibleUpstreamMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("bridges a legacy file through persistence startup before running the J5 lane", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j5-migration-startup-" });
    const filename = path.join(directory, "state.sqlite");
    yield* installLegacy().pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    for (let startup = 0; startup < 2; startup++) {
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          (yield* readHistory()).map(({ migration_id, name }) => [migration_id, name] as const),
          migrationManifest,
        );
        const j5 = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`SELECT migration_id, name FROM j5_a2a_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          j5.map(({ migration_id, name }) => [migration_id, name]),
          j5MigrationEntries.map(([id, name]) => [id, name]),
        );
      }).pipe(Effect.provide(makeSqlitePersistenceLive(filename)));
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("upgrades legacy history without rerunning V2 SQL or changing J5/native state", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* installLegacy();
    yield* runJ5A2AMigrations();
    yield* sql`INSERT INTO j5_a2a_squadron (id, name, created_at)
      VALUES ('squadron:keep', 'Keep', '2026-08-15T12:00:00Z')`;
    yield* sql`INSERT INTO j5_a2a_exchange
      (squadron_id, exchange_id, sender_id, receiver_id, status, intent, opened_seq, created_at, updated_at)
      VALUES ('squadron:keep', 'exchange:keep', 'agent:sender', 'human:receiver', 'open',
        'Preserve this obligation', 1, '2026-08-15T12:00:00Z', '2026-08-15T12:00:00Z')`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, provider, status, updated_at, payload_json, driver, provider_instance_id)
      VALUES ('native:keep', 'thread:keep', 'codex', 'ready', '2026-08-15T12:00:00Z',
        '{"nativeThreadId":"native:keep"}', 'codex', 'codex')`;
    const history = yield* readHistory();
    const j5History = yield* sql`SELECT * FROM j5_a2a_migrations ORDER BY migration_id`;
    const exchanges = yield* sql`SELECT * FROM j5_a2a_exchange`;
    const nativeThreads = yield* sql`SELECT * FROM orchestration_v2_projection_provider_threads`;

    // This is the actual bad path: the ordinary runner skips the inserted SQL
    // and attempts the already-applied Foundation migration at its new id.
    const unbridged = yield* Effect.exit(runMigrations());
    assert.isTrue(Exit.isFailure(unbridged));
    if (Exit.isFailure(unbridged))
      assert.match(Cause.pretty(unbridged.cause), /duplicate column name: driver/);
    assert.deepStrictEqual(yield* readHistory(), history);

    const executed = yield* runJ5CompatibleUpstreamMigrations();
    assert.deepStrictEqual(
      executed.map(([id]) => id),
      [41, 42, 43, 44, 45, 46, 47, 57, 58, 59],
    );
    const upgraded = yield* readHistory();
    assert.deepStrictEqual(
      upgraded.map(({ migration_id, name }) => [migration_id, name] as const),
      migrationManifest,
    );
    for (const row of history) {
      assert.deepStrictEqual(
        upgraded.find(({ name }) => name === row.name),
        {
          ...row,
          migration_id: row.migration_id >= 41 ? row.migration_id + 7 : row.migration_id,
        },
      );
    }
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM j5_a2a_migrations ORDER BY migration_id`,
      j5History,
    );
    assert.deepStrictEqual(yield* sql`SELECT * FROM j5_a2a_exchange`, exchanges);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM orchestration_v2_projection_provider_threads`,
      nativeThreads,
    );
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    assert.deepStrictEqual(yield* runJ5CompatibleUpstreamMigrations(), []);
    assert.deepStrictEqual(yield* readHistory(), upgraded);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

for (const through of [40, 47, 56, 59]) {
  it.effect(`accepts the current migration prefix through ${through}`, () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: through });
      const existing = yield* readHistory();
      const executed = yield* runJ5CompatibleUpstreamMigrations();
      assert.deepStrictEqual(
        executed,
        migrationManifest.filter(([id]) => id > through),
      );
      assert.deepStrictEqual((yield* readHistory()).slice(0, through), existing);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}

it.effect("refuses an untracked database before creating migration history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE unexpected_state (value TEXT)`;
    const before = yield* readSchema();
    const exit = yield* Effect.exit(runJ5CompatibleUpstreamMigrations());
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit))
      assert.match(Cause.pretty(exit.cause), /tables exist without migration history/);
    assert.deepStrictEqual(yield* readSchema(), before);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("refuses incomplete, renamed, or ahead migration histories without writes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* installLegacy();
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 49`;
    yield* assertRefused(/neither a current prefix nor the reviewed legacy history/);
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (49, 'LegacyV1ImportState')`;
    yield* sql`UPDATE effect_sql_migrations SET name = 'Unexpected' WHERE migration_id = 20`;
    yield* assertRefused(/neither a current prefix nor the reviewed legacy history/);
    yield* sql`UPDATE effect_sql_migrations SET name = 'AuthAccessManagement' WHERE migration_id = 20`;
    yield* runJ5CompatibleUpstreamMigrations();
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (60, 'Future')`;
    yield* assertRefused(/neither a current prefix nor the reviewed legacy history/);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("refuses legacy schema drift even when the recorded history matches", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* installLegacy();
    yield* sql`DROP INDEX orchestration_v2_effect_outbox_claim_idx`;
    yield* assertRefused(/legacy history does not match the reviewed schema/);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "applies the missing upstream data correction while preserving explicit model choices",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* installLegacy();
      yield* seedProjectDefaults();
      yield* runJ5CompatibleUpstreamMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT project_id, default_model_selection_json FROM projection_projects ORDER BY project_id`,
        [
          { project_id: "automatic", default_model_selection_json: null },
          { project_id: "explicit", default_model_selection_json: modelSelection },
        ],
      );
      const payloads = yield* sql<{ readonly stream_id: string; readonly model_type: string }>`
      SELECT stream_id, json_type(payload_json, '$.defaultModelSelection') AS model_type
      FROM orchestration_events WHERE event_type = 'project.created' ORDER BY stream_id
    `;
      assert.deepStrictEqual(payloads, [
        { stream_id: "automatic", model_type: "null" },
        { stream_id: "explicit", model_type: "object" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rolls back earlier schema additions if a missing data migration fails", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* installLegacy();
    yield* seedProjectDefaults();
    const projects = yield* sql`SELECT * FROM projection_projects ORDER BY project_id`;
    const events = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
    yield* sql`CREATE TRIGGER reject_project_update BEFORE UPDATE ON projection_projects
      BEGIN SELECT RAISE(ABORT, 'injected data migration failure'); END`;
    yield* assertRefused(/injected data migration failure/);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM projection_projects ORDER BY project_id`,
      projects,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`,
      events,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "rolls back inserted SQL and renumbering when a subsequent upstream migration fails",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* installLegacy();
      yield* sql`CREATE TRIGGER reject_pending_migrations BEFORE INSERT ON effect_sql_migrations
      WHEN NEW.migration_id = 57 BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`;
      yield* assertRefused(/injected migration failure/);
      yield* sql`DROP TRIGGER reject_pending_migrations`;
      assert.lengthOf(yield* runJ5CompatibleUpstreamMigrations(), 10);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("serializes concurrent upgrade attempts on the same client", () =>
  Effect.gen(function* () {
    yield* installLegacy();
    const results = yield* Effect.all(
      [runJ5CompatibleUpstreamMigrations(), runJ5CompatibleUpstreamMigrations()],
      { concurrency: "unbounded" },
    );
    assert.deepStrictEqual(
      results.map((rows) => rows.length).sort((a, b) => a - b),
      [0, 10],
    );
    assert.lengthOf(yield* readHistory(), 59);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
