/** The slice of a thread's Squadron home the sidebar rule reads. */
export type SidebarMembershipHome =
  | { readonly kind: "known"; readonly origin?: "human" | "agent" | undefined }
  | { readonly kind: "unknown" };

/**
 * SB5 sidebar membership (register D22): human-created agents show; agent-spawned Peer Agents
 * (Crew members included) are roster-only unless the user pinned them. `origin` is the home
 * read's statement of placement provenance, so only a thread that sits under a spawner leaves
 * the top level. Unknown provenance shows, never guesses.
 */
export const isSidebarMember = (
  thread: { readonly pinnedAt?: string | null | undefined },
  home: SidebarMembershipHome | undefined,
) => !(home?.kind === "known" && home.origin === "agent" && thread.pinnedAt == null);
