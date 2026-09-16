import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";

import type { FleetAgent, FleetCrew, FleetSquadron } from "./fleetClient";

/** One rendered row of the Roster tree. Crew members hang under their Captain as one unit. */
export interface FleetRow {
  readonly agent: FleetAgent;
  readonly depth: number;
  /** The Crew this row belongs to when it is a member; the Captain's own row has none. */
  readonly crewInstanceId: string | null;
}

export interface FleetCrewGroup {
  readonly crewInstanceId: string;
  readonly crewName: string;
  /** Seats are nodes too: a helper an agent places under a seat renders beneath that seat. */
  readonly members: ReadonlyArray<FleetNode>;
}

/** A tree node: an agent, its non-Crew children, and the Crews it commands as collapsible groups. */
export interface FleetNode {
  readonly row: FleetRow;
  readonly children: ReadonlyArray<FleetNode>;
  readonly crews: ReadonlyArray<FleetCrewGroup>;
}

const byLabel = (left: FleetAgent, right: FleetAgent) =>
  (left.displayName ?? left.participantId).localeCompare(right.displayName ?? right.participantId);

/**
 * Placement tree grouped per Squadron: roots are agents whose parent is null or not in the
 * Squadron; Crew members are pulled out of the plain child list and grouped under their
 * Captain by Crew. Agents that sit in a Crew but whose Captain is gone still render at the root.
 */
export function buildFleetTree(squadron: FleetSquadron): ReadonlyArray<FleetNode> {
  const byId = new Map(squadron.agents.map((agent) => [agent.participantId, agent]));
  const children = new Map<string | null, Array<FleetAgent>>();
  for (const agent of squadron.agents) {
    const parent =
      agent.placementParentId !== null && byId.has(agent.placementParentId)
        ? agent.placementParentId
        : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(agent);
    children.set(parent, siblings);
  }
  const visited = new Set<string>();
  const build = (agent: FleetAgent, depth: number): FleetNode => {
    visited.add(agent.participantId);
    const own = (children.get(agent.participantId) ?? [])
      .filter((child) => !visited.has(child.participantId))
      .toSorted(byLabel);
    const crewGroups = new Map<string, { name: string; members: Array<FleetNode> }>();
    const plain: Array<FleetNode> = [];
    for (const child of own) {
      if (child.crew !== null && child.crew.captainParticipantId === agent.participantId) {
        const group = crewGroups.get(child.crew.crewInstanceId) ?? {
          name: child.crew.crewName,
          members: [],
        };
        const seat = build(child, depth + 2);
        group.members.push({
          ...seat,
          row: { ...seat.row, crewInstanceId: child.crew.crewInstanceId },
        });
        crewGroups.set(child.crew.crewInstanceId, group);
      } else {
        plain.push(build(child, depth + 1));
      }
    }
    return {
      row: { agent, depth, crewInstanceId: null },
      children: plain,
      crews: [...crewGroups.entries()].map(([crewInstanceId, group]) => ({
        crewInstanceId,
        crewName: group.name,
        members: group.members,
      })),
    };
  };
  const roots = (children.get(null) ?? [])
    .toSorted(byLabel)
    .filter((agent) => !visited.has(agent.participantId))
    .map((agent) => build(agent, 0));
  // A corrupt placement cycle has no root; surface its agents rather than losing them.
  for (const agent of [...squadron.agents].toSorted(byLabel)) {
    if (!visited.has(agent.participantId)) roots.push(build(agent, 0));
  }
  return roots;
}

/**
 * Retired Crews of a Squadron, newest retirement first. Their roster snapshot stays readable so
 * whoever proposes a successor can start from the brief and the approved seats (Crews AC20).
 */
export const retiredCrews = (squadron: FleetSquadron): ReadonlyArray<FleetCrew> =>
  squadron.crews
    .filter((crew) => crew.archivedAt !== null)
    .toSorted((left, right) => (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""));

/** Roster alert badge: measured "needs a human" facts only, so nothing here is guessed. */
export const countFleetAlerts = (squadrons: ReadonlyArray<FleetSquadron>) =>
  squadrons.reduce(
    (count, squadron) => count + squadron.agents.filter((agent) => agent.openAsks > 0).length,
    0,
  );

/** Origin copy for the Roster row; unknown renders as `?` rather than a plausible guess. */
export const originLabel = (origin: FleetAgent["origin"]) =>
  origin === "human" ? "Human-created" : origin === "agent" ? "Agent-spawned" : "?";

/**
 * The sidebar rows the roster says are involved in a Crew or a spawn: every seat, every Captain
 * a seat names, and every agent with a placed child. The Fleet poll re-reads Crew chips and
 * children for these rows (and for the rows still showing one; see refreshCrewMembershipRows)
 * and no others, so that read's cost follows involvement, not the thread list. A Captain that
 * gained a Crew on another device is named here on the next poll. The live read carries no
 * retired Crew, so a Captain whose last Crew retired is not named here; its chip clears because
 * the row still holds one.
 */
export function fleetInvolvedThreadRefs(
  squadrons: ReadonlyArray<FleetSquadron & { readonly environmentId: EnvironmentId }>,
): ReadonlyArray<ScopedThreadRef> {
  const refs = new Map<string, ScopedThreadRef>();
  for (const squadron of squadrons) {
    const byId = new Map(squadron.agents.map((agent) => [agent.participantId, agent]));
    const involve = (participantId: string) => {
      const threadId = byId.get(participantId)?.threadId ?? null;
      if (threadId === null) return;
      const ref = scopeThreadRef(squadron.environmentId, ThreadId.make(threadId));
      refs.set(`${ref.environmentId}\u0000${ref.threadId}`, ref);
    };
    for (const agent of squadron.agents) {
      if (agent.crew !== null) {
        involve(agent.participantId);
        involve(agent.crew.captainParticipantId);
      }
      if (agent.placementParentId !== null) involve(agent.placementParentId);
    }
  }
  return [...refs.values()];
}
