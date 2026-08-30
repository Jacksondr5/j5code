import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";

import Migration0001 from "./migrations/001_EpicCommunicationLedger.ts";
import Migration0002 from "./migrations/002_SendDeliverReply.ts";
import Migration0003 from "./migrations/003_SquadronRename.ts";
import Migration0004 from "./migrations/004_SilenceNoticeChannel.ts";
import Migration0005 from "./migrations/005_ImmutableThreadHome.ts";
import Migration0006 from "./migrations/006_HumanNode.ts";

export const J5_A2A_MIGRATIONS_TABLE = "j5_a2a_migrations";

// Entries 1 and 2 are persisted migration history. Keep their file and manifest names unchanged;
// applied migrations are skipped by id and never rerun.
export const migrationEntries = [
  [1, "EpicCommunicationLedger", Migration0001],
  [2, "SendDeliverReply", Migration0002],
  [3, "SquadronRename", Migration0003],
  [4, "SilenceNoticeChannel", Migration0004],
  [5, "ImmutableThreadHome", Migration0005],
  [6, "HumanNode", Migration0006],
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
