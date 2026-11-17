/** The newest migration in each J5 ledger, keyed by its table. Upstream's ledger is reported
 * on its own, as `databaseMigration`. */
export type J5DatabaseMigrations = Readonly<Record<string, number>>;

/** Whether a release can open a database with these J5 ledgers. Either side is undefined when it
 * predates J5 reporting its ledgers. A ledger the release does not list is one it predates. */
export function j5DatabaseMigrationGap(
  database: J5DatabaseMigrations | undefined,
  release: J5DatabaseMigrations | undefined,
): "database-unknown" | "release-unknown" | "database-ahead" | null {
  if (database === undefined) return "database-unknown";
  if (release === undefined) return "release-unknown";
  return Object.entries(database).some(([ledger, head]) => (release[ledger] ?? 0) < head)
    ? "database-ahead"
    : null;
}

/** The file each J5 release publishes beside its archives: `{ databaseMigration, j5DatabaseMigrations }`,
 * the newest migration its server knows in upstream's ledger and in each J5 ledger. */
export const J5_RELEASE_METADATA_FILE = "release-metadata.json";
