import { ThreadId } from "@t3tools/contracts";
import type { FleetAgent, FleetProject } from "@t3tools/contracts/j5";

/** One J5 command relation of a thread, as a Lineage row shows it. */
export interface J5LineageRow {
  readonly threadId: ThreadId;
  readonly displayName: string | null;
  /** `captain` and `parent` command this thread; a `seat` or `peer` is placed under it. */
  readonly role: "captain" | "parent" | "seat" | "peer";
  /** The Crew that makes this a Captain or seat relation. */
  readonly crew: { readonly crewName: string; readonly seat: string | null } | null;
}

const toRow = (
  agent: FleetAgent & { readonly threadId: string },
  role: J5LineageRow["role"],
  crew: J5LineageRow["crew"] = null,
): J5LineageRow => ({
  threadId: ThreadId.make(agent.threadId),
  displayName: agent.displayName,
  role,
  crew,
});

const hasThread = (agent: FleetAgent | undefined): agent is FleetAgent & { threadId: string } =>
  agent !== undefined && agent.threadId !== null;

/**
 * The J5 placement tree around one thread, from its environment's live Fleet roster: who commands
 * it (placement parent, and its Crew's Captain when re-placed elsewhere) and the Peer Agents and
 * Crew seats placed under it or in Crews it commands. Placement, not provenance: a fork sits beside
 * its source, and upstream subagents and side chats are never ledger participants.
 */
export function deriveJ5LineageRows(
  projects: ReadonlyArray<FleetProject>,
  threadId: ThreadId,
): ReadonlyArray<J5LineageRow> {
  const agents = projects.flatMap((project) => project.agents);
  const self = agents.find((agent) => agent.threadId === threadId);
  if (self === undefined) return [];
  const byParticipant = new Map(agents.map((agent) => [agent.participantId, agent]));
  const rows: Array<J5LineageRow> = [];

  const captainId = self.crew?.captainParticipantId ?? null;
  const parentId = self.placementParentId ?? captainId;
  const parent = parentId === null ? undefined : byParticipant.get(parentId);
  const crew = self.crew === null ? null : { crewName: self.crew.crewName, seat: null };
  if (hasThread(parent))
    rows.push(parentId === captainId ? toRow(parent, "captain", crew) : toRow(parent, "parent"));
  const captain =
    captainId === null || captainId === parentId ? undefined : byParticipant.get(captainId);
  if (hasThread(captain)) rows.push(toRow(captain, "captain", crew));

  const children = agents
    .filter(
      (agent): agent is FleetAgent & { threadId: string } =>
        hasThread(agent) &&
        agent.threadId !== threadId &&
        // A seat re-placed elsewhere still sits in this Captain's Crew.
        ((agent.placementParentId ?? agent.crew?.captainParticipantId) === self.participantId ||
          agent.crew?.captainParticipantId === self.participantId),
    )
    .toSorted(
      (left, right) =>
        Number(left.crew === null) - Number(right.crew === null) ||
        (left.crew?.crewName ?? "").localeCompare(right.crew?.crewName ?? "") ||
        (left.crew?.seat ?? left.displayName ?? "").localeCompare(
          right.crew?.seat ?? right.displayName ?? "",
        ),
    );
  for (const child of children)
    rows.push(
      child.crew === null
        ? toRow(child, "peer")
        : toRow(child, "seat", { crewName: child.crew.crewName, seat: child.crew.seat }),
    );
  return rows;
}

/**
 * Upstream's tag-filter rule for Lineage: a hidden thread's row goes. While any environment is
 * hiding, a parent or Captain the shell hasn't loaded may be hidden too, so it goes; seats and
 * peers stay, since they follow this visible thread.
 */
export const visibleJ5LineageRows = (
  rows: ReadonlyArray<J5LineageRow>,
  filter: {
    readonly isHidden: (threadId: ThreadId) => boolean;
    readonly hidingAnywhere: boolean;
    readonly loaded: ReadonlySet<ThreadId>;
  },
): ReadonlyArray<J5LineageRow> =>
  rows.filter(
    (row) =>
      !filter.isHidden(row.threadId) &&
      !(
        filter.hidingAnywhere &&
        (row.role === "parent" || row.role === "captain") &&
        !filter.loaded.has(row.threadId)
      ),
  );
