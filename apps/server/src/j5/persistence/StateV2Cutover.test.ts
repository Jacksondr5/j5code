// @effect-diagnostics nodeBuiltinImport:off - fixtures compare database files byte-for-byte.
import * as NodeFS from "node:fs";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { layerTest } from "../../config.ts";
import { layerConfig } from "../../persistence/Layers/Sqlite.ts";
import { migrationManifest } from "../../persistence/Migrations.ts";
import { runJ5A2AMigrations } from "../a2a/Migrations.ts";
import { installPin } from "./test-support/historicalMigrations.ts";

// Upstream copies `state.sqlite` to `statev2.sqlite` once, before persistence starts.
// J5's compatibility wrapper and lanes must then run against the copy only.

const readHistory = Effect.fn("readHistory")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`).map(
    ({ migration_id, name }) => [migration_id, name] as const,
  );
});

/** Every row of every J5 table, as sorted JSON, so row survival is compared exactly. */
const readJ5Rows = Effect.fn("readJ5Rows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'j5\\_%' ESCAPE '\\'
      AND name <> 'j5_upstream_migration_history' ORDER BY name`;
  const rows: Record<string, ReadonlyArray<string>> = {};
  for (const { name } of tables) {
    const table = yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM "${name}"`);
    rows[name] = table.map((row) => JSON.stringify(row)).toSorted();
  }
  return rows;
});

const seedPinWithJ5State = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* installPin();
  yield* runJ5A2AMigrations();
  yield* sql`INSERT INTO j5_a2a_squadron (id, name, created_at)
    VALUES ('squadron:keep', 'Keep', '2026-09-10T12:00:00Z')`;
  yield* sql`INSERT INTO j5_a2a_exchange
    (squadron_id, exchange_id, sender_id, receiver_id, status, intent, opened_seq, created_at, updated_at)
    VALUES ('squadron:keep', 'exchange:keep', 'agent:sender', 'human:receiver', 'open',
      'Preserve this obligation', 1, '2026-09-10T12:00:00Z', '2026-09-10T12:00:00Z')`;
  return yield* readJ5Rows();
});

const withBaseDir = <A, E>(
  body: (paths: {
    readonly baseDir: string;
    readonly sourcePath: string;
    readonly destinationPath: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "j5-statev2-" });
    const stateDir = path.join(baseDir, "userdata");
    yield* fs.makeDirectory(stateDir, { recursive: true });
    return yield* body({
      baseDir,
      sourcePath: path.join(stateDir, "state.sqlite"),
      destinationPath: path.join(stateDir, "statev2.sqlite"),
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** The production startup path: ServerConfig → initializeV2Database → wrapper → J5 lanes. */
const boot = <A, E>(baseDir: string, body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  body.pipe(
    Effect.provide(
      layerConfig.pipe(
        Layer.provide(layerTest(baseDir, baseDir).pipe(Layer.provideMerge(NodeServices.layer))),
      ),
    ),
  );

const atFile = (filename: string) => NodeSqliteClient.layer({ filename });

it.effect("copies state.sqlite first, then upgrades only the copy with every J5 row intact", () =>
  withBaseDir(({ baseDir, sourcePath, destinationPath }) =>
    Effect.gen(function* () {
      const j5Rows = yield* seedPinWithJ5State.pipe(Effect.provide(atFile(sourcePath)));
      const original = NodeFS.readFileSync(sourcePath);

      for (let startup = 0; startup < 2; startup++) {
        yield* boot(
          baseDir,
          Effect.gen(function* () {
            assert.deepStrictEqual(yield* readHistory(), migrationManifest);
            assert.deepStrictEqual(yield* readJ5Rows(), j5Rows);
          }),
        );
      }
      assert.isTrue(NodeFS.existsSync(destinationPath));
      // The V1 file is a rollback snapshot: untouched, still at the pin's history.
      assert.deepStrictEqual(NodeFS.readFileSync(sourcePath), original);
      const pinHistory = yield* readHistory().pipe(Effect.provide(atFile(sourcePath)));
      assert.deepStrictEqual(pinHistory.at(-1), [51, "OrchestrationV2"]);
    }),
  ),
);

it.effect("an existing statev2.sqlite wins and state.sqlite is never recopied", () =>
  withBaseDir(({ baseDir, sourcePath }) =>
    Effect.gen(function* () {
      yield* seedPinWithJ5State.pipe(Effect.provide(atFile(sourcePath)));
      yield* boot(baseDir, Effect.void);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO j5_a2a_squadron (id, name, created_at)
          VALUES ('squadron:v1-only', 'Written by an old binary', '2026-09-24T00:00:00Z')`;
      }).pipe(Effect.provide(atFile(sourcePath)));
      yield* boot(
        baseDir,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(
            yield* sql`SELECT id FROM j5_a2a_squadron WHERE id = 'squadron:v1-only'`,
            [],
          );
        }),
      );
    }),
  ),
);

it.effect("a failed first boot leaves the published copy unmigrated and the retry upgrades it", () =>
  withBaseDir(({ baseDir, sourcePath, destinationPath }) =>
    Effect.gen(function* () {
      const j5Rows = yield* Effect.gen(function* () {
        const rows = yield* seedPinWithJ5State;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER inject BEFORE INSERT ON effect_sql_migrations
          WHEN NEW.migration_id = 55 BEGIN SELECT RAISE(ABORT, 'injected first-boot failure'); END`;
        return rows;
      }).pipe(Effect.provide(atFile(sourcePath)));

      const first = yield* Effect.exit(boot(baseDir, Effect.void));
      assert.isTrue(Exit.isFailure(first));
      assert.isTrue(NodeFS.existsSync(destinationPath));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual((yield* readHistory()).at(-1), [51, "OrchestrationV2"]);
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM pragma_table_info('projection_threads')
            WHERE name = 'title_state_json'`,
          [],
        );
        // Stand-in for the fixed binary; the V1 file keeps the trigger, so a recopy would fail.
        yield* sql`DROP TRIGGER inject`;
      }).pipe(Effect.provide(atFile(destinationPath)));

      yield* boot(
        baseDir,
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* readHistory(), migrationManifest);
          assert.deepStrictEqual(yield* readJ5Rows(), j5Rows);
        }),
      );
    }),
  ),
);
