import {
  j5DatabaseMigrationGap,
  type J5DatabaseMigrations,
} from "@t3tools/shared/j5/databaseMigrations";

/** A track switch J5's ledgers block where upstream's own checks pass. */
export type J5ChannelSwitchBlock = "j5-server-predates-checks" | "j5-release-predates-checks";

export const isJ5ChannelSwitchBlock = (block: string): block is J5ChannelSwitchBlock =>
  block === "j5-server-predates-checks" || block === "j5-release-predates-checks";

/** J5's ledgers as a track-switch block. A database ahead reads as upstream's "unsupported". */
export function j5ChannelSwitchBlock(
  database: J5DatabaseMigrations | undefined,
  release: J5DatabaseMigrations | undefined,
): J5ChannelSwitchBlock | "unsupported" | null {
  switch (j5DatabaseMigrationGap(database, release)) {
    case null:
      return null;
    case "database-unknown":
      return "j5-server-predates-checks";
    case "release-unknown":
      return "j5-release-predates-checks";
    case "database-ahead":
      return "unsupported";
  }
}

/** Upstream's predates-checks reasons would be wrong here: the server or release has upstream's
 * checks but not J5's. English until J5's screens are translated (#1180). */
export function j5ChannelSwitchBlockReason(
  block: J5ChannelSwitchBlock,
  input: { readonly version: string; readonly from: string; readonly to: string },
): string {
  return block === "j5-server-predates-checks"
    ? `its server predates J5's database checks; update it on ${input.from} first`
    : `${input.version} predates J5's database checks; wait for a newer ${input.to} release`;
}
