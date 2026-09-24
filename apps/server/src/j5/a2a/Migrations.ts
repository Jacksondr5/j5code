import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";

import Migration0001 from "./migrations/001_EpicCommunicationLedger.ts";
import Migration0002 from "./migrations/002_SendDeliverReply.ts";
import Migration0003 from "./migrations/003_SquadronRename.ts";
import Migration0004 from "./migrations/004_SilenceNoticeChannel.ts";
import Migration0005 from "./migrations/005_ImmutableThreadHome.ts";
import Migration0006 from "./migrations/006_HumanNode.ts";
import Migration0007 from "./migrations/007_ParticipantPlacement.ts";
import Migration0008 from "./migrations/008_LifecycleClosure.ts";
import Migration0009 from "./migrations/009_SquadronProjectReferences.ts";
import Migration0011 from "./migrations/011_ReversibleLifecycle.ts";
import Migration0012 from "./migrations/012_AgentHandoffs.ts";
import Migration0010 from "./migrations/010_OpenInboxCountIndex.ts";
import Migration0013 from "./migrations/013_MachineParticipants.ts";
import Migration0014 from "./migrations/014_AgentCrews.ts";
import Migration0015 from "./migrations/015_CustomCrewSeats.ts";
import Migration0016 from "./migrations/016_CrewProposalClaims.ts";
import Migration0017 from "./migrations/017_EnsureCustomCrewSeats.ts";
import Migration0018 from "./migrations/018_Peers.ts";
import Migration0019 from "./migrations/019_PeerDeliveryOrigin.ts";
import Migration0020 from "./migrations/020_PeerDeliveryReceiver.ts";
import Migration0021 from "./migrations/021_PeerRouteIndexes.ts";

export const J5_A2A_MIGRATIONS_TABLE = "j5_a2a_migrations";

// Every entry already in this list is persisted migration history: keep its id, file, and
// manifest name unchanged. Applied migrations are skipped by id and never rerun.
export const migrationEntries = [
  [1, "EpicCommunicationLedger", Migration0001],
  [2, "SendDeliverReply", Migration0002],
  [3, "SquadronRename", Migration0003],
  [4, "SilenceNoticeChannel", Migration0004],
  [5, "ImmutableThreadHome", Migration0005],
  [6, "HumanNode", Migration0006],
  [7, "ParticipantPlacement", Migration0007],
  [8, "LifecycleClosure", Migration0008],
  [9, "SquadronProjectReferences", Migration0009],
  [10, "OpenInboxCountIndex", Migration0010],
  [11, "ReversibleLifecycle", Migration0011],
  [12, "AgentHandoffs", Migration0012],
  [13, "MachineParticipants", Migration0013],
  [14, "AgentCrews", Migration0014],
  [15, "CustomCrewSeats", Migration0015],
  // 16 sits below 15 in the stack that introduced both (the claims change under the custom-seats
  // change). Ids are never renumbered once a development database has run them: the migrator
  // skips every id at or below the latest applied.
  [16, "CrewProposalClaims", Migration0016],
  // Covers databases that ran the lower stack through 16 before 15 became available.
  [17, "EnsureCustomCrewSeats", Migration0017],
  [18, "Peers", Migration0018],
  [19, "PeerDeliveryOrigin", Migration0019],
  [20, "PeerDeliveryReceiver", Migration0020],
  [21, "PeerRouteIndexes", Migration0021],
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
