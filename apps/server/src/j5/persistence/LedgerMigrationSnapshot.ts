import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { J5_A2A_MIGRATIONS_TABLE, migrationEntries } from "../a2a/Migrations.ts";

/**
 * The J5 ledger migrations that get a snapshot first. None does yet. A migration adds its id here
 * in the same PR that adds the migration, and only if it rewrites or drops data destructively; an
 * ordinary migration must not cost a full copy of the database. Never list an id ahead of its
 * migration: another migration can take the number first.
 */
export const J5_LEDGER_SNAPSHOT_MIGRATIONS: ReadonlyArray<number> = [];

const describeCause = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export class LedgerMigrationSnapshotError extends Schema.TaggedError<LedgerMigrationSnapshotError>()(
  "LedgerMigrationSnapshotError",
  {
    databasePath: Schema.String,
    snapshotPath: Schema.String,
    migrationId: Schema.Finite,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not snapshot ${this.databasePath} to ${this.snapshotPath} before J5 ledger migration ${this.migrationId}: ${describeCause(this.cause)}. The migration has not run.`;
  }
}

const isLedgerMigrationSnapshotError = Schema.is(LedgerMigrationSnapshotError);

export interface SnapshotBeforeJ5LedgerMigrationOptions {
  /** The J5 ledger migration ids this build knows. Defaults to `migrationEntries`. */
  readonly migrationIds?: ReadonlyArray<number>;
  /** Defaults to `J5_LEDGER_SNAPSHOT_MIGRATIONS`. */
  readonly guardedMigrationIds?: ReadonlyArray<number>;
}

/** `statev2.sqlite` → `statev2.pre-j5-<id>.sqlite` (the id padded to three digits), beside the database. */
export const ledgerMigrationSnapshotPath = (path: Path.Path, dbPath: string, migrationId: number) =>
  path.join(
    path.dirname(dbPath),
    `${path.basename(dbPath, ".sqlite")}.pre-j5-${String(migrationId).padStart(3, "0")}.sqlite`,
  );

/** The latest applied J5 ledger migration, or undefined when the database has no J5 ledger. */
const readLatestAppliedMigration = (filename: string) => {
  const database = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    const table = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(J5_A2A_MIGRATIONS_TABLE);
    if (table === undefined) return undefined;
    const row = database
      .prepare(`SELECT MAX(migration_id) AS latest FROM "${J5_A2A_MIGRATIONS_TABLE}"`)
      .get();
    return Number(row?.latest ?? 0);
  } finally {
    database.close();
  }
};

/**
 * Call before anything opens the database read-write. When a guarded J5 ledger migration is about
 * to run, this copies the database to `statev2.pre-j5-<id>.sqlite` first, and
 * fails rather than let the migration run without that copy. It replaces an older snapshot of the
 * same name: a pending migration means the database is still the pre-migration one. Nothing
 * deletes snapshots; a person does (`docs/j5/runbooks/dogfood-runtime.md`).
 */
export const snapshotBeforeJ5LedgerMigration = Effect.fn("snapshotBeforeJ5LedgerMigration")(
  function* (dbPath: string, options: SnapshotBeforeJ5LedgerMigrationOptions = {}) {
    const knownIds = new Set(options.migrationIds ?? migrationEntries.map(([id]) => id));
    const guardedIds = (options.guardedMigrationIds ?? J5_LEDGER_SNAPSHOT_MIGRATIONS)
      .filter((id) => knownIds.has(id))
      .toSorted((left, right) => left - right);
    const lowestGuardedId = guardedIds[0];
    if (lowestGuardedId === undefined) return;

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const failFor = (migrationId: number) => (cause: unknown) =>
      isLedgerMigrationSnapshotError(cause)
        ? cause
        : new LedgerMigrationSnapshotError({
            databasePath: dbPath,
            snapshotPath: ledgerMigrationSnapshotPath(path, dbPath, migrationId),
            migrationId,
            cause,
          });
    // The migrator skips every id at or below the latest applied one, so that is what pending
    // means. The snapshot is named for the first guarded migration that will actually run.
    const readFirstPending = (
      filename: string,
      fail: (cause: unknown) => LedgerMigrationSnapshotError,
    ) =>
      Effect.try({
        try: () => {
          const latest = readLatestAppliedMigration(filename);
          return latest === undefined ? undefined : guardedIds.find((id) => id > latest);
        },
        catch: fail,
      });

    if (!(yield* fs.exists(dbPath).pipe(Effect.mapError(failFor(lowestGuardedId))))) return;
    const pendingId = yield* readFirstPending(dbPath, failFor(lowestGuardedId));
    if (pendingId === undefined) return;

    const fail = failFor(pendingId);
    const snapshotPath = ledgerMigrationSnapshotPath(path, dbPath, pendingId);
    // Per attempt: two processes starting together must each publish only their own complete copy.
    const partialPath = `${snapshotPath}.${process.pid}.${NodeCrypto.randomUUID()}.partial`;

    yield* Effect.gen(function* () {
      const { size } = yield* fs.stat(dbPath);
      yield* Effect.logInfo("Snapshotting the database before a J5 ledger migration", {
        databasePath: dbPath,
        databaseBytes: Number(size),
        snapshotPath,
        migrationId: pendingId,
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
        // Another process may have migrated while this one copied. Never publish a
        // post-migration copy over a real snapshot.
        if ((yield* readFirstPending(partialPath, fail)) !== pendingId) {
          yield* fs.remove(partialPath, { force: true });
          return false;
        }
        yield* fs.rename(partialPath, snapshotPath);
        return true;
      }).pipe(
        Effect.tapError(() => fs.remove(partialPath, { force: true }).pipe(Effect.ignore)),
        Effect.timed,
      );
      yield* Effect.logInfo(
        published
          ? "Snapshot written before the J5 ledger migration"
          : "Snapshot discarded: another process already ran the J5 ledger migration",
        { snapshotPath, durationMs: Duration.toMillis(elapsed) },
      );
    }).pipe(Effect.mapError(fail));
  },
);
