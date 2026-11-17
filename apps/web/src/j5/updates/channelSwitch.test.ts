import { describe, expect, it } from "vite-plus/test";

import { localSwitchBlockReason } from "../../components/sidebar/updateEverything.logic";

// The decisions are tested on j5DatabaseMigrationGap; these rows check the plan uses it, in its words.
describe("a track switch checks J5's ledgers", () => {
  const nightly = "0.1.4-nightly.20261027.3796";
  const stable = (j5DatabaseMigrations?: Record<string, number>) => ({
    channel: "latest" as const,
    version: "0.1.3",
    databaseMigration: 69,
    ...(j5DatabaseMigrations === undefined ? {} : { j5DatabaseMigrations }),
  });
  const server = (j5DatabaseMigrations?: Record<string, number>) => ({
    connected: true,
    databaseMigration: 69,
    ...(j5DatabaseMigrations === undefined ? {} : { j5DatabaseMigrations }),
  });
  const heads = { j5_a2a_migrations: 57, j5_run_observability_migrations: 1 };

  it.each([
    { name: "allows a release that knows every ledger", db: heads, release: heads, reason: null },
    {
      name: "blocks a database ahead in one ledger",
      db: { ...heads, j5_a2a_migrations: 58 },
      release: heads,
      reason:
        "its database has changes 0.1.3 does not support yet; stay on Nightly until Stable has them",
    },
    {
      name: "blocks a server that reports no J5 ledgers",
      db: undefined,
      release: heads,
      reason: "its server predates J5's database checks; update it on Nightly first",
    },
    {
      name: "blocks a release that publishes no J5 ledgers",
      db: heads,
      release: undefined,
      reason: "0.1.3 predates J5's database checks; wait for a newer Stable release",
    },
  ])("$name", ({ db, release, reason }) => {
    expect(localSwitchBlockReason(nightly, stable(release), [server(db)], 1)).toBe(reason);
  });
});
