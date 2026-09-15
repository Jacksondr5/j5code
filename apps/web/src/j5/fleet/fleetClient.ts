import type { J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentId } from "@t3tools/contracts";
import type { FleetResponse, FleetSquadron } from "@t3tools/contracts/j5";

import { refreshCrewMemberships } from "../squadron/CrewMembershipsClient";
import { refreshSpawnedChildren } from "../squadron/SpawnedChildrenClient";
import {
  fleetDetailQueryAtom,
  fleetDetailSourcesAtom,
  fleetQueryAtom,
  fleetSourcesAtom,
  refreshJ5Sources,
} from "../state";
import { createVisibleRefreshHook } from "../useVisibleRefresh";

export type { FleetAgent, FleetCrew, FleetResponse, FleetSquadron } from "@t3tools/contracts/j5";

/** The roster changes on the scale of turns, not keystrokes; poll rarely and only while visible. */
export const FLEET_POLL_INTERVAL_MS = 30_000;

export type ScopedFleetSquadron = FleetSquadron & {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
};

/** Every connected environment's Squadrons, each tagged with the environment its threads live on. */
export const mergeFleetSources = (
  sources: J5ReadSources<FleetResponse>,
): ReadonlyArray<ScopedFleetSquadron> =>
  sources.sources.flatMap((source) =>
    (source.data?.squadrons ?? []).map((squadron) => ({
      ...squadron,
      environmentId: source.environmentId,
      environmentLabel: source.environmentLabel,
    })),
  );

/** The page's read, retired Crews and rosters included. */
export const refreshFleet = () =>
  refreshJ5Sources(fleetDetailSourcesAtom, fleetDetailQueryAtom, { force: true });

/**
 * The always-mounted rail badge polls the live roster only (no retired Crews, no rosters); the
 * sidebar's Crew chips and children re-read on the same cadence, so a Crew change reaches every
 * surface within one poll without a full re-read on each shells change.
 */
export const useFleetRefresh = createVisibleRefreshHook(() => {
  void refreshJ5Sources(fleetSourcesAtom, fleetQueryAtom);
  refreshCrewMemberships();
  refreshSpawnedChildren();
}, FLEET_POLL_INTERVAL_MS);

/** The Fleet page's own poll while it is open; retired Crews ride only here. */
export const useFleetDetailRefresh = createVisibleRefreshHook(() => {
  void refreshJ5Sources(fleetDetailSourcesAtom, fleetDetailQueryAtom);
}, FLEET_POLL_INTERVAL_MS);
