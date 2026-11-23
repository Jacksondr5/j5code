import { crossesReleaseTrack } from "@t3tools/shared/cliRelease";
import {
  j5DatabaseMigrationGap,
  type J5DatabaseMigrations,
} from "@t3tools/shared/j5/databaseMigrations";

/** Upstream's `trackSwitchBlockReason` for J5's ledgers: the host's own check before it crosses
 * tracks, since its database may have moved on after the client planned the switch. */
export function j5TrackSwitchBlockReason(input: {
  readonly serverVersion: string;
  readonly targetVersion: string;
  readonly targetJ5DatabaseMigrations: J5DatabaseMigrations | undefined;
  /** Read only for a crossing; undefined when the database cannot be read. */
  readonly databaseMigrations: () => J5DatabaseMigrations | undefined;
}): string | null {
  if (!crossesReleaseTrack(input.serverVersion, input.targetVersion)) return null;
  const gap = j5DatabaseMigrationGap(input.databaseMigrations(), input.targetJ5DatabaseMigrations);
  if (gap === null) return null;
  return gap === "database-ahead"
    ? `This database has changes j5@${input.targetVersion} does not support yet; it stays on this release.`
    : `Cannot confirm this database works with j5@${input.targetVersion}. Switch tracks from Settings → About → Update track, which checks it first.`;
}
