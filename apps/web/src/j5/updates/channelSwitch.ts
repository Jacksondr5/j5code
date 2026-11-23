import {
  j5DatabaseMigrationGap,
  type J5DatabaseMigrations,
} from "@t3tools/shared/j5/databaseMigrations";

/** Upstream's `channelSwitchBlockReason` for J5's ledgers, in its words. */
export function j5ChannelSwitchBlockReason(input: {
  readonly version: string;
  readonly from: string;
  readonly to: string;
  readonly database: J5DatabaseMigrations | undefined;
  readonly release: J5DatabaseMigrations | undefined;
}): string | null {
  switch (j5DatabaseMigrationGap(input.database, input.release)) {
    case null:
      return null;
    case "database-unknown":
      return `its server predates J5's database checks; update it on ${input.from} first`;
    case "release-unknown":
      return `${input.version} predates J5's database checks; wait for a newer ${input.to} release`;
    case "database-ahead":
      return `its database has changes ${input.version} does not support yet; stay on ${input.from} until ${input.to} has them`;
  }
}
