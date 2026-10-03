import * as NodeSqlite from "node:sqlite";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { J5_A2A_MIGRATIONS_TABLE, migrationEntries } from "../a2a/Migrations.ts";

/** The first J5 ledger migration that rewrites data a person cannot rebuild by hand. */
export const J5_LEDGER_SNAPSHOT_FROM_MIGRATION = 30;

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

export interface SnapshotBeforeJ5LedgerMigrationOptions {
  /** The J5 ledger migration ids this build knows. Defaults to `migrationEntries`. */
  readonly migrationIds?: ReadonlyArray<number>;
  readonly fromMigrationId?: number;
}

/** `statev2.sqlite` → `statev2.pre-j5-030.sqlite`, beside the database. */
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
 * Call before anything opens the database read-write. When a J5 ledger migration at or above the
 * threshold is about to run, this copies the database to `statev2.pre-j5-<id>.sqlite` first, and
 * fails rather than let the migration run without that copy. It replaces an older snapshot of the
 * same name: a pending migration means the database is still the pre-migration one. Nothing
 * deletes snapshots; a person does (`docs/j5/runbooks/dogfood-runtime.md`).
 */
export const snapshotBeforeJ5LedgerMigration = Effect.fn("snapshotBeforeJ5LedgerMigration")(
  function* (dbPath: string, options: SnapshotBeforeJ5LedgerMigrationOptions = {}) {
    const fromMigrationId = options.fromMigrationId ?? J5_LEDGER_SNAPSHOT_FROM_MIGRATION;
    const guardedIds = (options.migrationIds ?? migrationEntries.map(([id]) => id))
      .filter((id) => id >= fromMigrationId)
      .toSorted((left, right) => left - right);
    const guardedId = guardedIds[0];
    if (guardedId === undefined) return;

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const snapshotPath = ledgerMigrationSnapshotPath(path, dbPath, guardedId);
    const partialPath = `${snapshotPath}.partial`;
    // The migrator skips every id at or below the latest applied one, so that is what pending means.
    const isPending = (filename: string) => {
      const latest = readLatestAppliedMigration(filename);
      return latest !== undefined && guardedIds.some((id) => id > latest);
    };

    const fail = (cause: unknown) =>
      Schema.is(LedgerMigrationSnapshotError)(cause)
        ? cause
        : new LedgerMigrationSnapshotError({
            databasePath: dbPath,
            snapshotPath,
            migrationId: guardedId,
            cause,
          });
    const checkPending = (filename: string) =>
      Effect.try({ try: () => isPending(filename), catch: fail });

    yield* Effect.gen(function* () {
      if (!(yield* fs.exists(dbPath))) return;
      if (!(yield* checkPending(dbPath))) return;

      const { size } = yield* fs.stat(dbPath);
      yield* Effect.logInfo("Snapshotting the database before a J5 ledger migration", {
        databasePath: dbPath,
        databaseBytes: Number(size),
        snapshotPath,
        migrationId: guardedId,
      });
      const [elapsed, published] = yield* Effect.gen(function* () {
        // A crash mid-backup leaves this behind.
        yield* fs.remove(partialPath, { force: true });
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
        if (!(yield* checkPending(partialPath))) {
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
