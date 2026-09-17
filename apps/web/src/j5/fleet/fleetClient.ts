import type { J5ReadSources } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentId } from "@t3tools/contracts";
import type { FleetResponse, FleetSquadron } from "@t3tools/contracts/j5";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { refreshCrewMembershipRows } from "../squadron/CrewMembershipsClient";
import { refreshSpawnedChildrenRows } from "../squadron/SpawnedChildrenClient";
import { fleetQueryAtom, fleetSourcesAtom, refreshJ5Sources } from "../state";
import { createVisibleRefreshHook } from "../useVisibleRefresh";
import { fleetInvolvedThreadRefs } from "./fleet.logic";

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

export const refreshFleet = () =>
  refreshJ5Sources(fleetSourcesAtom, fleetQueryAtom, { force: true });

/**
 * The rail badge and the page share this one foreground poll. Once the roster is read, the
 * sidebar's Crew chips and children re-read for the rows the roster names as involved (seats,
 * their Captains, spawners with placed children) and no others, so a Crew change reaches every
 * surface within one poll while the per-thread reads stay bounded by Crew activity rather than
 * by the length of the thread list.
 */
export const useFleetRefresh = createVisibleRefreshHook(() => {
  refreshJ5Sources(fleetSourcesAtom, fleetQueryAtom)
    .then(() => {
      const involved = fleetInvolvedThreadRefs(
        mergeFleetSources(appAtomRegistry.get(fleetSourcesAtom)),
      );
      refreshCrewMembershipRows(involved);
      refreshSpawnedChildrenRows(involved);
    })
    // A failed roster read skips this tick's row re-reads; the next tick tries again.
    .catch((error: unknown) => {
      console.warn("[j5] fleet refresh failed", error);
    });
}, FLEET_POLL_INTERVAL_MS);
