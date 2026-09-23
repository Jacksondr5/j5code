import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import { migrationEntries as j5MigrationEntries, runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { runJ5CompatibleUpstreamMigrations } from "./UpstreamMigrationCompatibility.ts";

import { installHistorical } from "./test-support/historicalMigrations.ts";
import collapse from "./reviewed-v2-collapse.v1.json" with { type: "json" };
const installLegacy = () => installHistorical("august");

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

    const executed = yield* runJ5CompatibleUpstreamMigrations();
    assert.deepStrictEqual(
      executed.map(([id]) => id),
      [41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51],
    );
    const upgraded = yield* readHistory();
    assert.deepStrictEqual(
      upgraded.map(({ migration_id, name }) => [migration_id, name] as const),
      migrationManifest,
    );
    assert.deepStrictEqual(upgraded.slice(0, 40), history.slice(0, 40));
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id, name, created_at
      FROM j5_upstream_migration_history ORDER BY migration_id`,
      history,
    );
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

for (const through of [40, 47, 48, 49, 50, 51]) {
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
    yield* assertRefused(/neither a current prefix nor a reviewed historical history/);
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (49, 'LegacyV1ImportState')`;
    yield* sql`UPDATE effect_sql_migrations SET name = 'Unexpected' WHERE migration_id = 20`;
    yield* assertRefused(/neither a current prefix nor a reviewed historical history/);
    yield* sql`UPDATE effect_sql_migrations SET name = 'AuthAccessManagement' WHERE migration_id = 20`;
    yield* runJ5CompatibleUpstreamMigrations();
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (60, 'Future')`;
    yield* assertRefused(/neither a current prefix nor a reviewed historical history/);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("refuses legacy schema drift even when the recorded history matches", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* installLegacy();
    yield* sql`DROP INDEX orchestration_v2_effect_outbox_claim_idx`;
    yield* assertRefused(/historical migration history does not match the reviewed schema/);
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
      WHEN NEW.migration_id = 51 BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`;
      yield* assertRefused(/injected migration failure/);
      yield* sql`DROP TRIGGER reject_pending_migrations`;
      assert.lengthOf(yield* runJ5CompatibleUpstreamMigrations(), 11);
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
      [0, 11],
    );
    assert.lengthOf(yield* readHistory(), 51);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

for (let through = 48; through <= 59; through++) {
  it.effect(`completes reviewed September prefix ${through} without replaying existing steps`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* installHistorical("september", through);
      const original = yield* readHistory();
      yield* runJ5CompatibleUpstreamMigrations();
      assert.deepStrictEqual(
        (yield* readHistory()).map(({ migration_id, name }) => [migration_id, name] as const),
        migrationManifest,
      );
      assert.deepStrictEqual((yield* readHistory()).slice(0, 47), original.slice(0, 47));
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name, created_at FROM j5_upstream_migration_history
        WHERE source_ref = ${collapse.sourceRef} ORDER BY migration_id`,
        original,
      );
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
      assert.deepStrictEqual(yield* runJ5CompatibleUpstreamMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}

it.effect("rejects September schema drift without rewriting history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* installHistorical("september");
    yield* sql`DROP INDEX orchestration_v2_effect_outbox_claim_idx`;
    yield* assertRefused(/does not match the reviewed schema/);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "rolls back new SQL and archived history when composition recording fails, then retries",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* installHistorical("september", 56);
      yield* sql`CREATE TRIGGER reject_composition BEFORE INSERT ON effect_sql_migrations
      WHEN NEW.migration_id = 51 BEGIN SELECT RAISE(ABORT, 'composition failure'); END`;
      yield* assertRefused(/composition failure/);
      yield* sql`DROP TRIGGER reject_composition`;
      assert.lengthOf(yield* runJ5CompatibleUpstreamMigrations(), 4);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("demonstrates why the unbridged runner cannot upgrade August history", () =>
  Effect.gen(function* () {
    yield* installLegacy();
    const history = yield* readHistory();
    const unbridged = yield* Effect.exit(runMigrations());
    assert.isTrue(Exit.isFailure(unbridged));
    if (Exit.isFailure(unbridged))
      assert.match(Cause.pretty(unbridged.cause), /no such column: linked_pull_request_json/);
    assert.deepStrictEqual(yield* readHistory(), history);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "the bridge applies changes the normal high-water runner silently skips for September",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* installHistorical("september");
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'projection_thread_pull_requests'`,
        [],
      );
      yield* runJ5CompatibleUpstreamMigrations();
      assert.lengthOf(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'projection_thread_pull_requests'`,
        1,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "completes a partial September application-event migration without losing its old events",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* installHistorical("september", 52);
      yield* sql`INSERT INTO orchestration_v2_events
      (event_id, thread_id, event_type, occurred_at, payload_json, driver, provider_instance_id)
      VALUES ('event:preserve', 'thread:preserve', 'test.preserve', '2026-09-01', '{"keep":true}', 'codex', 'codex')`;
      yield* runJ5CompatibleUpstreamMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT event_id, payload_json, application_event_version FROM orchestration_events
      WHERE event_id = 'event:preserve'`,
        [
          {
            event_id: "event:preserve",
            payload_json: '{"keep":true}',
            application_event_version: 2,
          },
        ],
      );
      yield* runJ5CompatibleUpstreamMigrations();
      assert.lengthOf(
        yield* sql`SELECT event_id FROM orchestration_events WHERE event_id = 'event:preserve'`,
        1,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("upgrades to the same upstream schema as a fresh install", () =>
  Effect.gen(function* () {
    const fresh = yield* Effect.gen(function* () {
      yield* runMigrations();
      return yield* readSchema();
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory()));
    yield* installHistorical("september", 56);
    yield* runJ5CompatibleUpstreamMigrations();
    const upgraded = yield* readSchema();
    assert.deepStrictEqual(
      upgraded.filter((row) => !String(row.name).includes("j5_upstream_migration_history")),
      fresh,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("backfills September PR links once while preserving malformed legacy data", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* installHistorical("september");
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project:links', 'Links', '/test/links', '[]', '2026-09-01', '2026-09-01')`;
    for (const [id, link] of [
      [
        "github",
        '{"repository":"Acme/Widgets","number":42,"url":"https://GitHub.com/Acme/Widgets/pull/42"}',
      ],
      [
        "azure",
        '{"repository":"widgets","number":7,"url":"https://dev.azure.com/acme/project/_git/widgets/pullrequest/7"}',
      ],
      ["malformed", "{broken"],
    ]) {
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, linked_pull_request_json, created_at, updated_at)
        VALUES (${id}, 'project:links', ${id}, ${modelSelection}, ${link}, '2026-09-01', '2026-09-02')`;
    }
    const original =
      yield* sql`SELECT thread_id, linked_pull_request_json FROM projection_threads ORDER BY thread_id`;
    for (let startup = 0; startup < 2; startup++) {
      yield* runJ5CompatibleUpstreamMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT thread_id, host, repository, number, source, linked_at
        FROM projection_thread_pull_requests ORDER BY thread_id`,
        [
          {
            thread_id: "azure",
            host: "dev.azure.com",
            repository: "acme/project/_git/widgets",
            number: 7,
            source: "manual",
            linked_at: "2026-09-02",
          },
          {
            thread_id: "github",
            host: "github.com",
            repository: "acme/widgets",
            number: 42,
            source: "manual",
            linked_at: "2026-09-02",
          },
        ],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT thread_id, linked_pull_request_json FROM projection_threads ORDER BY thread_id`,
        original,
      );
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("refuses gaps, renamed entries and unknown September suffixes before writes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* installHistorical("september");
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 52`;
    yield* assertRefused(/neither a current prefix nor a reviewed historical history/);
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (52, 'OrchestrationV2ThreadLaunchWorkflows')`;
    yield* sql`UPDATE effect_sql_migrations SET name = 'Unexpected' WHERE migration_id = 59`;
    yield* assertRefused(/neither a current prefix nor a reviewed historical history/);
    yield* sql`UPDATE effect_sql_migrations SET name = 'OrchestrationV2ShellIndexes' WHERE migration_id = 59`;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (60, 'Unreviewed')`;
    yield* assertRefused(/neither a current prefix nor a reviewed historical history/);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
