import { describe, expect, it } from "vite-plus/test";

import { j5DatabaseMigrationGap } from "./databaseMigrations.ts";

describe("j5DatabaseMigrationGap", () => {
  const heads = { j5_a2a_migrations: 57, j5_run_observability_migrations: 1 };

  it.each([
    { name: "a release that knows every ledger", db: heads, release: heads, gap: null },
    {
      name: "a release with a ledger the database lacks",
      db: { j5_a2a_migrations: 57 },
      release: heads,
      gap: null,
    },
    {
      name: "a database ahead in one ledger",
      db: { ...heads, j5_a2a_migrations: 58 },
      release: heads,
      gap: "database-ahead",
    },
    {
      name: "a ledger the release predates",
      db: heads,
      release: { j5_a2a_migrations: 57 },
      gap: "database-ahead",
    },
    {
      name: "a server that reports no ledgers",
      db: undefined,
      release: heads,
      gap: "database-unknown",
    },
    {
      name: "a release that publishes no ledgers",
      db: heads,
      release: undefined,
      gap: "release-unknown",
    },
    {
      name: "neither side reporting ledgers",
      db: undefined,
      release: undefined,
      gap: "database-unknown",
    },
  ] as const)("$name", ({ db, release, gap }) => {
    expect(j5DatabaseMigrationGap(db, release)).toBe(gap);
  });
});
