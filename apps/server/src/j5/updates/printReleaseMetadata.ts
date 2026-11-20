// Prints the metadata a J5 release publishes as `release-metadata.json`, read by the server's
// release lookup when a track switch checks which databases the release can open.
import { J5_BUILD_MIGRATION_HEADS } from "../persistence/j5MigrationLedgers.ts";
import { BUILD_MIGRATION_HEAD } from "../../persistence/databaseMigrationHead.ts";

process.stdout.write(
  `${JSON.stringify({
    databaseMigration: BUILD_MIGRATION_HEAD,
    j5DatabaseMigrations: J5_BUILD_MIGRATION_HEADS,
  })}\n`,
);
