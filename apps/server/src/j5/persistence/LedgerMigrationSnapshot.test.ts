// @effect-diagnostics nodeBuiltinImport:off - fixtures read database files directly.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import {
  J5_A2A_MIGRATIONS_TABLE,
  migrationEntries,
  runJ5A2AMigrations,
} from "../a2a/Migrations.ts";
import {
  J5_LEDGER_SNAPSHOT_MIGRATIONS,
  LedgerMigrationSnapshotError,
  ledgerMigrationSnapshotPath,
  snapshotBeforeJ5LedgerMigration,
} from "./LedgerMigrationSnapshot.ts";

const withDatabasePath = <A, E>(
  body: (paths: {
    readonly dbPath: string;
    readonly snapshotPath: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j5-ledger-snapshot-" });
    const dbPath = path.join(directory, "statev2.sqlite");
    return yield* body({ dbPath, snapshotPath: ledgerMigrationSnapshotPath(path, dbPath, 30) });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** These tests guard 030 themselves, so they do not move when the shipped list does. */
const guarding030 = { guardedMigrationIds: [30] };

/** A database with a J5 ledger whose latest applied migration is `latestApplied`. */
const seedLedger = (database: NodeSqlite.DatabaseSync, latestApplied: number) => {
  database.exec(`
    CREATE TABLE ${J5_A2A_MIGRATIONS_TABLE} (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    );
    CREATE TABLE j5_a2a_squadron (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO j5_a2a_squadron VALUES ('squadron:keep', 'Keep');
  `);
  const insert = database.prepare(
    `INSERT INTO ${J5_A2A_MIGRATIONS_TABLE} (migration_id, name) VALUES (?, ?)`,
  );
  for (let id = 1; id <= latestApplied; id++) insert.run(id, `Migration${id}`);
};

const createLedgerDatabase = (dbPath: string, latestApplied: number) => {
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    seedLedger(database, latestApplied);
  } finally {
    database.close();
  }
};

/** Every row of every table, so two database files are compared by content. */
const readContent = (filename: string) => {
  const database = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all();
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        database
          .prepare(`SELECT * FROM "${String(name)}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .toSorted(),
      ]),
    );
  } finally {
    database.close();
  }
};

it.effect("snapshots once, before migration 030, and not again after it applied", () =>
  withDatabasePath(({ dbPath, snapshotPath }) =>
    Effect.gen(function* () {
      const atDatabase = Effect.provide(NodeSqliteClient.layer({ filename: dbPath }));
      // The real migrator and the real migrations: 030 is pending.
      assert.isTrue(snapshotPath.endsWith("statev2.pre-j5-030.sqlite"));

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* runJ5A2AMigrations({ toMigrationInclusive: 29 });
        yield* sql`INSERT INTO j5_a2a_squadron (id, name, created_at)
          VALUES ('squadron:keep', 'Keep', '2026-09-10T12:00:00Z')`;
      }).pipe(atDatabase);
      const beforeMigration = readContent(dbPath);

      yield* snapshotBeforeJ5LedgerMigration(dbPath, guarding030);
      assert.deepStrictEqual(readContent(snapshotPath), beforeMigration);

      yield* runJ5A2AMigrations().pipe(atDatabase);
      assert.notDeepEqual(readContent(dbPath), beforeMigration);
      NodeFS.rmSync(snapshotPath);
      yield* snapshotBeforeJ5LedgerMigration(dbPath, guarding030);
      assert.isFalse(NodeFS.existsSync(snapshotPath));
    }),
  ),
);

// The real startup path, the real migrations and the shipped guarded list: nothing is a stand-in.
it.effect("startup snapshots the database before the ledger re-keys to projects", () =>
  withDatabasePath(({ dbPath }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const rekey = migrationEntries.find(([, name]) => name === "LedgerRekeysToProjects")![0];
      assert.deepStrictEqual(J5_LEDGER_SNAPSHOT_MIGRATIONS, [rekey]);
      const snapshotPath = ledgerMigrationSnapshotPath(path, dbPath, rekey);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* runJ5A2AMigrations({ toMigrationInclusive: rekey - 1 });
        yield* sql`INSERT INTO j5_a2a_squadron (id, name, created_at)
          VALUES ('squadron:keep', 'Keep', '2026-09-10T12:00:00Z')`;
        yield* sql`INSERT INTO j5_a2a_squadron_project_reference
          (squadron_id, project_id, ordinal, created_at)
          VALUES ('squadron:keep', 'project-keep', 0, '2026-09-10T12:00:00Z')`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
      const beforeMigration = readContent(dbPath);

      const migrated = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return {
          ledgers: yield* sql`SELECT project_id FROM j5_a2a_project_ledger`,
          applied: yield* sql`
            SELECT migration_id FROM ${sql(J5_A2A_MIGRATIONS_TABLE)} WHERE migration_id = ${rekey}
          `,
        };
      }).pipe(Effect.provide(makeSqlitePersistenceLive(dbPath)));

      // The live database was migrated; the copy beside it is the database as it was.
      assert.deepStrictEqual(migrated.ledgers, [{ project_id: "project-keep" }]);
      assert.deepStrictEqual(migrated.applied, [{ migration_id: rekey }]);
      assert.deepStrictEqual(readContent(snapshotPath), beforeMigration);
      assert.lengthOf(readContent(snapshotPath)["j5_a2a_squadron"] ?? [], 1);
    }),
  ),
);

it.effect("takes no snapshot when the database does not exist", () =>
  withDatabasePath(({ dbPath, snapshotPath }) =>
    Effect.gen(function* () {
      yield* snapshotBeforeJ5LedgerMigration(dbPath, guarding030);
      assert.isFalse(NodeFS.existsSync(snapshotPath));
      // A read-only check must not create the database either.
      assert.isFalse(NodeFS.existsSync(dbPath));
    }),
  ),
);

it.effect("takes no snapshot of a database that has no J5 ledger yet", () =>
  withDatabasePath(({ dbPath, snapshotPath }) =>
    Effect.gen(function* () {
      const database = new NodeSqlite.DatabaseSync(dbPath);
      database.exec("CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY)");
      database.close();
      yield* snapshotBeforeJ5LedgerMigration(dbPath, guarding030);
      assert.isFalse(NodeFS.existsSync(snapshotPath));
    }),
  ),
);

it.effect("takes no snapshot when the pending migration is not a guarded one", () =>
  withDatabasePath(({ dbPath, snapshotPath }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      createLedgerDatabase(dbPath, 28);
      // 29 is pending but not guarded, and this build knows no 30.
      yield* snapshotBeforeJ5LedgerMigration(dbPath, {
        migrationIds: [28, 29],
        guardedMigrationIds: [30],
      });
      assert.deepStrictEqual(NodeFS.readdirSync(path.dirname(dbPath)), ["statev2.sqlite"]);
      assert.isFalse(NodeFS.existsSync(snapshotPath));
    }),
  ),
);

it.effect("an ordinary later migration takes no snapshot and leaves the earlier one alone", () =>
  withDatabasePath(({ dbPath, snapshotPath }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      // 030 already ran and left its snapshot. A later build adds an unguarded 031.
      createLedgerDatabase(dbPath, 30);
      NodeFS.writeFileSync(snapshotPath, "the state before 030");

      yield* snapshotBeforeJ5LedgerMigration(dbPath, {
        migrationIds: [29, 30, 31],
        guardedMigrationIds: [30],
      });

      assert.strictEqual(NodeFS.readFileSync(snapshotPath, "utf8"), "the state before 030");
      assert.deepStrictEqual(NodeFS.readdirSync(path.dirname(dbPath)).toSorted(), [
        "statev2.pre-j5-030.sqlite",
        "statev2.sqlite",
      ]);
    }),
  ),
);

it.effect("a guarded later migration gets its own snapshot and leaves the earlier one alone", () =>
  withDatabasePath(({ dbPath, snapshotPath }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      createLedgerDatabase(dbPath, 30);
      NodeFS.writeFileSync(snapshotPath, "the state before 030");

      yield* snapshotBeforeJ5LedgerMigration(dbPath, {
        migrationIds: [29, 30, 31],
        guardedMigrationIds: [30, 31],
      });

      assert.strictEqual(NodeFS.readFileSync(snapshotPath, "utf8"), "the state before 030");
      assert.deepStrictEqual(
        readContent(ledgerMigrationSnapshotPath(path, dbPath, 31)),
        readContent(dbPath),
      );
    }),
  ),
);

it.effect("replaces an older snapshot and leaves no partial file behind", () =>
  withDatabasePath(({ dbPath, snapshotPath }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      createLedgerDatabase(dbPath, 29);
      NodeFS.writeFileSync(snapshotPath, "an older snapshot");

      yield* snapshotBeforeJ5LedgerMigration(dbPath, guarding030);

      assert.deepStrictEqual(readContent(snapshotPath), readContent(dbPath));
      assert.deepStrictEqual(
        NodeFS.readdirSync(path.dirname(dbPath)).filter((name) => name.endsWith(".partial")),
        [],
      );
    }),
  ),
);

it.effect("includes rows still in the WAL while another connection holds the database open", () =>
  withDatabasePath(({ dbPath, snapshotPath }) =>
    Effect.gen(function* () {
      const writer = new NodeSqlite.DatabaseSync(dbPath);
      yield* Effect.addFinalizer(() => Effect.sync(() => writer.close()));
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      seedLedger(writer, 29);
      writer.exec("INSERT INTO j5_a2a_squadron VALUES ('squadron:wal', 'Only in the WAL')");
      // Nothing has been checkpointed: the rows exist only in the WAL.
      assert.isAbove(NodeFS.statSync(`${dbPath}-wal`).size, 0);
      const mainFileBefore = NodeFS.readFileSync(dbPath);

      yield* snapshotBeforeJ5LedgerMigration(dbPath, guarding030);

      const content = readContent(snapshotPath);
      assert.deepStrictEqual(content, readContent(dbPath));
      assert.lengthOf(content["j5_a2a_squadron"] ?? [], 2);
      assert.lengthOf(content[J5_A2A_MIGRATIONS_TABLE] ?? [], 29);
      // The snapshot read the source; it did not checkpoint or otherwise write to it.
      assert.deepStrictEqual(NodeFS.readFileSync(dbPath), mainFileBefore);
      writer.exec("INSERT INTO j5_a2a_squadron VALUES ('squadron:after', 'Still writable')");
    }),
  ),
);

it.effect("fails, and publishes nothing, when the snapshot cannot be written", () =>
  withDatabasePath(({ dbPath, snapshotPath }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      createLedgerDatabase(dbPath, 29);
      const before = readContent(dbPath);
      // A non-empty directory under the snapshot's name cannot be replaced by the rename.
      NodeFS.mkdirSync(snapshotPath);
      NodeFS.writeFileSync(`${snapshotPath}/occupied`, "");

      const error = yield* Effect.flip(snapshotBeforeJ5LedgerMigration(dbPath, guarding030));

      assert.instanceOf(error, LedgerMigrationSnapshotError);
      assert.strictEqual(error.migrationId, 30);
      assert.include(error.message, snapshotPath);
      assert.include(error.message, "The migration has not run.");
      assert.deepStrictEqual(
        NodeFS.readdirSync(path.dirname(dbPath)).filter((name) => name.endsWith(".partial")),
        [],
      );
      assert.deepStrictEqual(readContent(dbPath), before);
    }),
  ),
);

it.effect("fails when the database cannot be read", () =>
  withDatabasePath(({ dbPath, snapshotPath }) =>
    Effect.gen(function* () {
      NodeFS.writeFileSync(dbPath, "this is not a SQLite database, and is long enough to say so");
      const error = yield* Effect.flip(snapshotBeforeJ5LedgerMigration(dbPath, guarding030));
      assert.instanceOf(error, LedgerMigrationSnapshotError);
      assert.isFalse(NodeFS.existsSync(snapshotPath));
    }),
  ),
);
