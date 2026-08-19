import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";

import Migration0001 from "./migrations/001_EpicCommunicationLedger.ts";
import Migration0002 from "./migrations/002_SendDeliverReply.ts";

export const J5_A2A_MIGRATIONS_TABLE = "j5_a2a_migrations";

export const migrationEntries = [
  [1, "EpicCommunicationLedger", Migration0001],
  [2, "SendDeliverReply", Migration0002],
] as const;

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const run = Migrator.make({});

export interface RunJ5A2AMigrationsOptions {
  readonly toMigrationInclusive?: number;
}

/**
 * J5 migrations deliberately use a separate tracking table and id space so an
 * upstream migration can never be skipped after a fork rebase.
 */
export const runJ5A2AMigrations = Effect.fn("runJ5A2AMigrations")(function* (
  options: RunJ5A2AMigrationsOptions = {},
) {
  return yield* run({
    table: J5_A2A_MIGRATIONS_TABLE,
    loader: makeMigrationLoader(options.toMigrationInclusive),
  });
});
