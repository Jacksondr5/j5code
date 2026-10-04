import type { OrchestrationV2Actor, OrchestrationV2CreationSource } from "@t3tools/contracts";

/** The thread's own creation facts the sidebar rule reads; all are on upstream's thread shell. */
export interface SidebarMembershipThread {
  readonly createdBy?: OrchestrationV2Actor | undefined;
  readonly creationSource?: OrchestrationV2CreationSource | undefined;
  readonly forkedFrom?: unknown;
  readonly pinnedAt?: string | null | undefined;
}

/**
 * Sidebar membership (register D22): a thread an agent created through the MCP tools (a Peer
 * Agent, Crew seats included) leaves the top level unless the person pinned it, and shows under
 * the agent that spawned it. A fork stays at the top level: its placement is beside its source,
 * not under the agent that forked it, so hiding it would leave it under no row at all.
 */
export const isSidebarMember = (thread: SidebarMembershipThread) =>
  !(
    thread.createdBy === "agent" &&
    thread.creationSource === "mcp" &&
    thread.forkedFrom == null &&
    thread.pinnedAt == null
  );
