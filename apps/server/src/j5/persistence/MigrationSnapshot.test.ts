// @effect-diagnostics nodeBuiltinImport:off - fixtures read database files directly.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as NodeWorkerThreads from "node:worker_threads";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import { layerFromPath } from "../../persistence/Sqlite.ts";
import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import {
  J5_A2A_MIGRATIONS_TABLE,
  migrationEntries,
  runJ5A2AMigrations,
} from "../a2a/Migrations.ts";
import {
  MigrationSnapshotError,
  migrationSnapshotPath,
  snapshotBeforeMigrations,
} from "./MigrationSnapshot.ts";

const newestUpstream = Math.max(...migrationManifest.map(([id]) => id));
const newestJ5 = Math.max(...migrationEntries.map(([id]) => id));

const withDatabasePath = <A, E>(
  body: (paths: {
    readonly dbPath: string;
    readonly directory: string;
    /** The snapshot of a database that recorded these migrations. */
    readonly snapshotAt: (upstream: number, j5: number) => string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "j5-migration-snapshot-" });
    const dbPath = path.join(directory, "statev2.sqlite");
    return yield* body({
      dbPath,
      directory,
      snapshotAt: (upstream, j5) => migrationSnapshotPath(path, dbPath, { upstream, j5 }),
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const createHistoryTable = (database: NodeSqlite.DatabaseSync, table: string, latest: number) => {
  database.exec(`
    CREATE TABLE ${table} (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    );
  `);
  const insert = database.prepare(`INSERT INTO ${table} (migration_id, name) VALUES (?, ?)`);
  for (let id = 1; id <= latest; id++) insert.run(id, `Migration${id}`);
};

/** A database that recorded upstream migrations through `upstream` and J5's through `j5`. */
const seedHistory = (database: NodeSqlite.DatabaseSync, upstream: number, j5: number) => {
  createHistoryTable(database, "effect_sql_migrations", upstream);
  createHistoryTable(database, J5_A2A_MIGRATIONS_TABLE, j5);
  database.exec(`
    CREATE TABLE j5_a2a_squadron (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO j5_a2a_squadron VALUES ('squadron:keep', 'Keep');
  `);
};

const createDatabase = (dbPath: string, upstream: number, j5: number) => {
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    seedHistory(database, upstream, j5);
  } finally {
    database.close();
  }
};

/** This build knows upstream's 1–10 and J5's 1–5. */
const build = { upstreamMigrationIds: [8, 9, 10], j5MigrationIds: [4, 5] };

const snapshotsIn = (directory: string) =>
  NodeFS.readdirSync(directory)
    .filter((name) => name.includes(".pre-migration-"))
    .toSorted();

/**
 * Runs `effect` with `onLog` as its only logger. Loggers run inline, so `onLog` sees the
 * snapshot's `copyStarts` message after the database's migration history has been read and before
 * the copy starts.
 */
const withLogs = <A, E, R>(effect: Effect.Effect<A, E, R>, onLog: (message: string) => void) =>
  effect.pipe(
    Effect.provide(
      Logger.layer([Logger.make(({ message }) => onLog(String(message)))], {
        mergeWithExisting: false,
      }),
    ),
  );
const copyStarts = "Snapshotting the database before its pending migrations";

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

it.effect("snapshots a database with a pending upstream migration, named for what it leaves", () =>
  withDatabasePath(({ dbPath, directory, snapshotAt }) =>
    Effect.gen(function* () {
      createDatabase(dbPath, 9, 5);
      yield* snapshotBeforeMigrations(dbPath, build);
      assert.deepStrictEqual(snapshotsIn(directory), ["statev2.pre-migration-u009-j005.sqlite"]);
      assert.deepStrictEqual(readContent(snapshotAt(9, 5)), readContent(dbPath));
    }),
  ),
);

it.effect("snapshots a database with a pending J5 ledger migration", () =>
  withDatabasePath(({ dbPath, directory, snapshotAt }) =>
    Effect.gen(function* () {
      createDatabase(dbPath, 10, 4);
      yield* snapshotBeforeMigrations(dbPath, build);
      assert.deepStrictEqual(snapshotsIn(directory), ["statev2.pre-migration-u010-j004.sqlite"]);
      assert.deepStrictEqual(readContent(snapshotAt(10, 4)), readContent(dbPath));
    }),
  ),
);

it.effect("snapshots an upstream database that has no J5 ledger yet", () =>
  withDatabasePath(({ dbPath, directory }) =>
    Effect.gen(function* () {
      const database = new NodeSqlite.DatabaseSync(dbPath);
      createHistoryTable(database, "effect_sql_migrations", 10);
      database.close();
      yield* snapshotBeforeMigrations(dbPath, build);
      assert.deepStrictEqual(snapshotsIn(directory), ["statev2.pre-migration-u010-j000.sqlite"]);
    }),
  ),
);

it.effect("takes no snapshot when nothing is pending, or when the database is ahead", () =>
  withDatabasePath(({ dbPath, directory }) =>
    Effect.gen(function* () {
      createDatabase(dbPath, 10, 5);
      yield* snapshotBeforeMigrations(dbPath, build);
      // A newer build's database: neither migrator would run anything.
      yield* snapshotBeforeMigrations(dbPath, { upstreamMigrationIds: [9], j5MigrationIds: [4] });
      assert.deepStrictEqual(NodeFS.readdirSync(directory), ["statev2.sqlite"]);
    }),
  ),
);

it.effect("takes no snapshot of a database that does not exist, and does not create it", () =>
  withDatabasePath(({ dbPath, directory }) =>
    Effect.gen(function* () {
      yield* snapshotBeforeMigrations(dbPath, build);
      assert.deepStrictEqual(NodeFS.readdirSync(directory), []);
    }),
  ),
);

it.effect("takes no snapshot of a database with no migration history", () =>
  withDatabasePath(({ dbPath, directory }) =>
    Effect.gen(function* () {
      const database = new NodeSqlite.DatabaseSync(dbPath);
      database.exec("CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY)");
      // A migrator that created its table and was interrupted before recording anything.
      createHistoryTable(database, "effect_sql_migrations", 0);
      database.close();
      yield* snapshotBeforeMigrations(dbPath, build);
      assert.deepStrictEqual(NodeFS.readdirSync(directory), ["statev2.sqlite"]);
    }),
  ),
);

// The real startup path and the real migrations in both lanes: nothing is a stand-in.
it.effect("startup snapshots once before real migrations, and a fresh database never", () =>
  withDatabasePath(({ dbPath, directory, snapshotAt }) =>
    Effect.gen(function* () {
      const start = Effect.void.pipe(Effect.provide(layerFromPath(dbPath)));
      // A first start creates and fully migrates the database: there was nothing to copy.
      yield* start;
      yield* start;
      assert.deepStrictEqual(snapshotsIn(directory), []);
      NodeFS.rmSync(dbPath);

      const rekey = migrationEntries.find(([, name]) => name === "LedgerRekeysToProjects")![0];
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
            SELECT MAX(migration_id) AS latest FROM ${sql(J5_A2A_MIGRATIONS_TABLE)}
          `,
        };
      }).pipe(Effect.provide(layerFromPath(dbPath)));

      // The live database was migrated; the copy beside it is the database as it was.
      assert.deepStrictEqual(migrated.ledgers, [{ project_id: "project-keep" }]);
      assert.deepStrictEqual(migrated.applied, [{ latest: newestJ5 }]);
      const snapshotPath = snapshotAt(newestUpstream, rekey - 1);
      assert.deepStrictEqual(readContent(snapshotPath), beforeMigration);
      assert.lengthOf(readContent(snapshotPath)["j5_a2a_squadron"] ?? [], 1);

      // Nothing is pending any more, so the next start copies nothing.
      NodeFS.rmSync(snapshotPath);
      yield* start;
      assert.deepStrictEqual(snapshotsIn(directory), []);
    }),
  ),
);

// Live: a partial file's age is measured against the real clock.
it.live("keeps the newest snapshots and removes the rest", () =>
  withDatabasePath(({ dbPath, directory, snapshotAt }) =>
    Effect.gen(function* () {
      createDatabase(dbPath, 9, 4);
      // Written oldest first. Age is by time written, not by name: the newest-named one is oldest.
      const older = [snapshotAt(9, 9), snapshotAt(3, 1), snapshotAt(5, 2), snapshotAt(7, 3)];
      older.forEach((file, index) => {
        NodeFS.writeFileSync(file, "an earlier snapshot");
        NodeFS.utimesSync(file, 1_000 + index, 1_000 + index);
      });
      // Not this mechanism's file: an earlier release's snapshot.
      NodeFS.writeFileSync(`${directory}/statev2.pre-j5-031.sqlite`, "");
      // Copies a killed process left behind, and one another process may still be writing.
      const abandoned = [
        `${snapshotAt(2, 1)}.7.a.partial`,
        `${snapshotAt(2, 1)}.7.a.partial-journal`,
      ];
      abandoned.forEach((file) => {
        NodeFS.writeFileSync(file, "");
        NodeFS.utimesSync(file, 1_000, 1_000);
      });
      NodeFS.writeFileSync(`${snapshotAt(1, 1)}.8.b.partial`, "");

      yield* snapshotBeforeMigrations(dbPath, { ...build, keep: 3 });

      assert.deepStrictEqual(snapshotsIn(directory), [
        "statev2.pre-migration-u001-j001.sqlite.8.b.partial",
        "statev2.pre-migration-u005-j002.sqlite",
        "statev2.pre-migration-u007-j003.sqlite",
        "statev2.pre-migration-u009-j004.sqlite",
      ]);
      assert.isTrue(NodeFS.existsSync(`${directory}/statev2.pre-j5-031.sqlite`));
      assert.deepStrictEqual(readContent(snapshotAt(9, 4)), readContent(dbPath));
    }),
  ),
);

it.effect("replaces an older snapshot of the same name and leaves no partial file behind", () =>
  withDatabasePath(({ dbPath, directory, snapshotAt }) =>
    Effect.gen(function* () {
      createDatabase(dbPath, 9, 4);
      NodeFS.writeFileSync(snapshotAt(9, 4), "an older snapshot");

      yield* snapshotBeforeMigrations(dbPath, build);

      assert.deepStrictEqual(readContent(snapshotAt(9, 4)), readContent(dbPath));
      assert.deepStrictEqual(snapshotsIn(directory), ["statev2.pre-migration-u009-j004.sqlite"]);
    }),
  ),
);

it.effect("includes rows still in the WAL while another connection holds the database open", () =>
  withDatabasePath(({ dbPath, snapshotAt }) =>
    Effect.gen(function* () {
      const writer = new NodeSqlite.DatabaseSync(dbPath);
      yield* Effect.addFinalizer(() => Effect.sync(() => writer.close()));
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      seedHistory(writer, 9, 4);
      writer.exec("INSERT INTO j5_a2a_squadron VALUES ('squadron:wal', 'Only in the WAL')");
      // Nothing has been checkpointed: the rows exist only in the WAL.
      assert.isAbove(NodeFS.statSync(`${dbPath}-wal`).size, 0);
      const mainFileBefore = NodeFS.readFileSync(dbPath);

      yield* snapshotBeforeMigrations(dbPath, build);

      const content = readContent(snapshotAt(9, 4));
      assert.deepStrictEqual(content, readContent(dbPath));
      assert.lengthOf(content["j5_a2a_squadron"] ?? [], 2);
      assert.lengthOf(content[J5_A2A_MIGRATIONS_TABLE] ?? [], 4);
      // The snapshot read the source; it did not checkpoint or otherwise write to it.
      assert.deepStrictEqual(NodeFS.readFileSync(dbPath), mainFileBefore);
      writer.exec("INSERT INTO j5_a2a_squadron VALUES ('squadron:after', 'Still writable')");
    }),
  ),
);

// A second connection on its own thread, committing as fast as it can until told to stop. The
// snapshot blocks this thread while it copies, so only another thread can commit during it.
const busyWriter = `
  const { parentPort, workerData } = require("node:worker_threads");
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(workerData.dbPath);
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = OFF;");
  const insert = database.prepare("INSERT INTO commits DEFAULT VALUES");
  const stop = new Int32Array(workerData.stop);
  let commits = 0;
  while (Atomics.load(stop, 0) === 0) {
    insert.run();
    commits += 1;
    if (commits === 1) parentPort.postMessage("writing");
  }
  database.close();
  parentPort.postMessage(commits);
`;

// In WAL mode, the one the server uses, a writer never makes the copy wait. With a rollback
// journal the database is locked against readers while each commit lands, so the copy has to wait
// its turn, and then holds the writer off until it is complete.
it.effect.each(["WAL", "DELETE"])(
  "copies a %s database while another connection keeps committing",
  (journalMode) =>
    withDatabasePath(({ dbPath, snapshotAt }) =>
      Effect.gen(function* () {
        const setup = new NodeSqlite.DatabaseSync(dbPath);
        setup.exec(`PRAGMA journal_mode = ${journalMode};`);
        seedHistory(setup, 9, 4);
        // About a thousand pages, so the writer has time to commit while they are copied.
        setup.exec(`
          CREATE TABLE filler (id INTEGER PRIMARY KEY, body BLOB NOT NULL);
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
          INSERT INTO filler (body) SELECT randomblob(3500) FROM n;
          CREATE TABLE commits (id INTEGER PRIMARY KEY);
        `);
        setup.close();

        const stop = new SharedArrayBuffer(4);
        const worker = new NodeWorkerThreads.Worker(busyWriter, {
          eval: true,
          workerData: { dbPath, stop },
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => worker.terminate()));
        const writing = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<number>();
        worker.on("message", (message) => {
          if (message === "writing") Deferred.doneUnsafe(writing, Effect.void);
          else Deferred.doneUnsafe(stopped, Effect.succeed(Number(message)));
        });
        // A writer that could not commit, which is how a copy holding it off too long shows.
        worker.on("error", (error) => Deferred.doneUnsafe(stopped, Effect.die(error)));
        yield* Deferred.await(writing);

        yield* snapshotBeforeMigrations(dbPath, build);
        Atomics.store(new Int32Array(stop), 0, 1);
        const commits = yield* Deferred.await(stopped);

        const copy = new NodeSqlite.DatabaseSync(snapshotAt(9, 4), { readOnly: true });
        yield* Effect.addFinalizer(() => Effect.sync(() => copy.close()));
        const count = (table: string) =>
          Number(copy.prepare(`SELECT COUNT(*) AS rows FROM ${table}`).get()?.rows);
        assert.strictEqual(copy.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
        assert.strictEqual(count("filler"), 1000);
        // One moment of a running writer: some of its commits, and it went on to make more.
        assert.isAbove(count("commits"), 0);
        assert.isBelow(count("commits"), commits);
      }),
    ),
);

it.effect("discards its copy when another process migrated the database first", () =>
  withDatabasePath(({ dbPath, directory }) =>
    Effect.gen(function* () {
      createDatabase(dbPath, 9, 4);
      const messages: Array<string> = [];

      // Another process's migrator records migration 10 after this one read the history as 9.
      yield* withLogs(snapshotBeforeMigrations(dbPath, build), (message) => {
        messages.push(message);
        if (!message.startsWith(copyStarts)) return;
        const other = new NodeSqlite.DatabaseSync(dbPath);
        try {
          other.exec("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (10, 'M10')");
        } finally {
          other.close();
        }
      });

      // Not published as the database "before migration 10", which it no longer is.
      assert.deepStrictEqual(NodeFS.readdirSync(directory), ["statev2.sqlite"]);
      assert.isTrue(messages.some((message) => message.startsWith("Snapshot discarded")));
    }),
  ),
);

it.effect("a failed copy publishes nothing, and startup stops before the database is opened", () =>
  withDatabasePath(({ dbPath, directory, snapshotAt }) =>
    Effect.gen(function* () {
      createDatabase(dbPath, newestUpstream - 1, newestJ5);
      const before = readContent(dbPath);
      const snapshotPath = snapshotAt(newestUpstream - 1, newestJ5);
      // A non-empty directory under the snapshot's name cannot be replaced by the rename.
      NodeFS.mkdirSync(snapshotPath);
      NodeFS.writeFileSync(`${snapshotPath}/occupied`, "");

      const error = yield* Effect.flip(snapshotBeforeMigrations(dbPath));

      assert.instanceOf(error, MigrationSnapshotError);
      assert.include(error.message, snapshotPath);
      assert.include(error.message, "Nothing has been migrated.");
      assert.deepStrictEqual(
        NodeFS.readdirSync(directory).filter((name) => name.endsWith(".partial")),
        [],
      );

      const startup = yield* Effect.exit(Effect.void.pipe(Effect.provide(layerFromPath(dbPath))));
      assert.isTrue(Exit.isFailure(startup));
      if (Exit.isFailure(startup)) assert.isTrue(Cause.hasDies(startup.cause));
      assert.deepStrictEqual(readContent(dbPath), before);
    }),
  ),
);

it.effect("fails when the database cannot be read", () =>
  withDatabasePath(({ dbPath, directory }) =>
    Effect.gen(function* () {
      NodeFS.writeFileSync(dbPath, "this is not a SQLite database, and is long enough to say so");
      const error = yield* Effect.flip(snapshotBeforeMigrations(dbPath, build));
      assert.instanceOf(error, MigrationSnapshotError);
      assert.deepStrictEqual(snapshotsIn(directory), []);
    }),
  ),
);
