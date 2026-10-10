// @effect-diagnostics nodeBuiltinImport:off - a per-attempt file suffix; this step must need nothing beyond FileSystem and Path.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { migrationManifest } from "../../persistence/Migrations.ts";
import { J5_A2A_MIGRATIONS_TABLE, migrationEntries } from "../a2a/Migrations.ts";

/**
 * How many pre-migration snapshots stay beside the database. Each is a full copy, so the number
 * is small: three lets a person go back across the last three builds that migrated, at three
 * times the database's size on disk.
 */
export const MIGRATION_SNAPSHOTS_KEPT = 3;

const UPSTREAM_MIGRATIONS_TABLE = "effect_sql_migrations";

const describeCause = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export class MigrationSnapshotError extends Schema.TaggedError<MigrationSnapshotError>()(
  "MigrationSnapshotError",
  {
    databasePath: Schema.String,
    snapshotPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not snapshot ${this.databasePath} to ${this.snapshotPath} before its pending migrations: ${describeCause(this.cause)}. Nothing has been migrated.`;
  }
}

/** The newest migration id each lane has recorded; 0 where a lane has recorded none. */
export interface RecordedMigrations {
  readonly upstream: number;
  readonly j5: number;
}

export interface SnapshotBeforeMigrationsOptions {
  /** The upstream migration ids this build knows. Defaults to upstream's manifest. */
  readonly upstreamMigrationIds?: ReadonlyArray<number>;
  /** The J5 ledger migration ids this build knows. Defaults to `migrationEntries`. */
  readonly j5MigrationIds?: ReadonlyArray<number>;
  /** Defaults to `MIGRATION_SNAPSHOTS_KEPT`. */
  readonly keep?: number;
}

const snapshotSuffix = /\.pre-migration-u\d+-j\d+\.sqlite$/;

/**
 * `statev2.sqlite` → `statev2.pre-migration-u<upstream id>-j<J5 ledger id>.sqlite`, beside the
 * database: named for the migrations the database had when it was copied, ids padded to three
 * digits.
 */
export const migrationSnapshotPath = (
  path: Path.Path,
  dbPath: string,
  recorded: RecordedMigrations,
) => {
  const pad = (id: number) => String(id).padStart(3, "0");
  return path.join(
    path.dirname(dbPath),
    `${path.basename(dbPath, ".sqlite")}.pre-migration-u${pad(recorded.upstream)}-j${pad(recorded.j5)}.sqlite`,
  );
};

const readRecordedMigrations = (filename: string): RecordedMigrations => {
  const database = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    const latest = (table: string) => {
      const exists = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (exists === undefined) return 0;
      const row = database.prepare(`SELECT MAX(migration_id) AS latest FROM "${table}"`).get();
      return Number(row?.latest ?? 0);
    };
    return { upstream: latest(UPSTREAM_MIGRATIONS_TABLE), j5: latest(J5_A2A_MIGRATIONS_TABLE) };
  } finally {
    database.close();
  }
};

/** Keeps `justWritten` and the most recently written others, `keep` in all. */
const removeOldSnapshots = Effect.fn("removeOldSnapshots")(function* (
  dbPath: string,
  justWritten: string,
  keep: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath, ".sqlite")}.pre-migration-`;
  const others = (yield* fs.readDirectory(directory))
    .filter((name) => name.startsWith(prefix) && snapshotSuffix.test(name))
    .map((name) => path.join(directory, name))
    .filter((file) => file !== justWritten);
  const written = yield* Effect.forEach(others, (file) =>
    fs.stat(file).pipe(
      Effect.map((info) => ({
        file,
        at: Option.match(info.mtime, { onNone: () => 0, onSome: (time) => time.getTime() }),
      })),
    ),
  );
  const expired = written
    .toSorted((left, right) => right.at - left.at)
    .slice(Math.max(0, keep - 1));
  for (const { file } of expired) {
    yield* fs.remove(file);
    yield* Effect.logInfo("Removed an old pre-migration snapshot", { snapshotPath: file });
  }
});

/**
 * Call before anything opens the database read-write. When the database has migration history
 * and this build would run a migration in either lane (upstream's or J5's ledger), this first
 * copies it to `migrationSnapshotPath`, and fails rather than let a migration run without that
 * copy. A database with no history is new and is not copied; neither is one with nothing pending,
 * so an ordinary start costs two small reads.
 *
 * The copy uses SQLite's backup API, which reads through the WAL and never writes to the source.
 * It is published only if it still records the same migrations, so a copy taken after another
 * process already migrated never replaces a real snapshot. It replaces an older snapshot of the
 * same name, and the oldest snapshots beyond `MIGRATION_SNAPSHOTS_KEPT` are then deleted.
 */
export const snapshotBeforeMigrations = Effect.fn("snapshotBeforeMigrations")(function* (
  dbPath: string,
  options: SnapshotBeforeMigrationsOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const newestKnown = {
    upstream: Math.max(0, ...(options.upstreamMigrationIds ?? migrationManifest.map(([id]) => id))),
    j5: Math.max(0, ...(options.j5MigrationIds ?? migrationEntries.map(([id]) => id))),
  };
  const failAt = (snapshotPath: string) => (cause: unknown) =>
    new MigrationSnapshotError({ databasePath: dbPath, snapshotPath, cause });
  const failBeforeNaming = failAt(path.join(path.dirname(dbPath), "(not yet named)"));

  if (!(yield* fs.exists(dbPath).pipe(Effect.mapError(failBeforeNaming)))) return;
  const recorded = yield* Effect.try({
    try: () => readRecordedMigrations(dbPath),
    catch: failBeforeNaming,
  });
  if (recorded.upstream === 0 && recorded.j5 === 0) return;
  // Each migrator runs every id above the newest it has recorded, so that is what pending means.
  // Upstream's renumbering of an older history is covered: such a history ends below the manifest.
  if (recorded.upstream >= newestKnown.upstream && recorded.j5 >= newestKnown.j5) return;

  const snapshotPath = migrationSnapshotPath(path, dbPath, recorded);
  const fail = failAt(snapshotPath);
  // Per attempt: two processes starting together must each publish only their own complete copy.
  const partialPath = `${snapshotPath}.${process.pid}.${NodeCrypto.randomUUID()}.partial`;
  const { size } = yield* fs.stat(dbPath).pipe(Effect.mapError(fail));
  yield* Effect.logInfo("Snapshotting the database before its pending migrations", {
    databasePath: dbPath,
    databaseBytes: Number(size),
    snapshotPath,
    recorded,
    newestKnown,
  });
  const [elapsed, published] = yield* Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async () => {
        const database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
        try {
          await NodeSqlite.backup(database, partialPath);
        } finally {
          database.close();
        }
      },
      catch: fail,
    });
    const copied = yield* Effect.try({
      try: () => readRecordedMigrations(partialPath),
      catch: fail,
    });
    if (copied.upstream !== recorded.upstream || copied.j5 !== recorded.j5) {
      yield* fs.remove(partialPath, { force: true }).pipe(Effect.mapError(fail));
      return false;
    }
    yield* fs.rename(partialPath, snapshotPath).pipe(Effect.mapError(fail));
    return true;
  }).pipe(
    Effect.tapError(() => fs.remove(partialPath, { force: true }).pipe(Effect.ignore)),
    Effect.timed,
  );
  yield* Effect.logInfo(
    published
      ? "Snapshot written before the pending migrations"
      : "Snapshot discarded: another process already migrated the database",
    { snapshotPath, durationMs: Duration.toMillis(elapsed) },
  );
  if (!published) return;

  // The snapshot that matters exists; a leftover old one is not worth refusing to start over.
  yield* removeOldSnapshots(dbPath, snapshotPath, options.keep ?? MIGRATION_SNAPSHOTS_KEPT).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not remove old pre-migration snapshots", {
        databasePath: dbPath,
        cause: describeCause(cause),
      }),
    ),
  );
});
